/**
 * Schema guardrails. These tests pin down the grounding contract:
 * what shape of object the analyzer is allowed to accept.
 *
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { BillingError, BillMetadata, HIGH_CONFIDENCE_TYPES } from "../src/types.ts";

describe("BillingError schema", () => {
  test("accepts a valid HIGH finding", () => {
    const parsed = BillingError.safeParse({
      line_quote: "| 3 | 03/14/2026 | 71046 | Chest X-ray, 2 views | 1 | $468.00 |",
      page_number: 1,
      error_type: "duplicate",
      confidence: "high",
      dollar_impact: 468,
      evidence: "Bill charges CPT 71046 on both rows 2 and 3.",
      cpt_code: "71046",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects negative dollar_impact", () => {
    const parsed = BillingError.safeParse({
      line_quote: "some quote",
      page_number: 1,
      error_type: "duplicate",
      confidence: "high",
      dollar_impact: -100,
      evidence: "some evidence",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects unknown error_type", () => {
    const parsed = BillingError.safeParse({
      line_quote: "some quote here",
      page_number: 1,
      error_type: "made_up_type",
      confidence: "high",
      dollar_impact: 100,
      evidence: "some evidence",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects line_quote shorter than 8 chars", () => {
    const parsed = BillingError.safeParse({
      line_quote: "too",
      page_number: 1,
      error_type: "duplicate",
      confidence: "high",
      dollar_impact: 100,
      evidence: "some evidence here",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects page_number < 1", () => {
    const parsed = BillingError.safeParse({
      line_quote: "valid line quote",
      page_number: 0,
      error_type: "duplicate",
      confidence: "high",
      dollar_impact: 100,
      evidence: "some evidence here",
    });
    expect(parsed.success).toBe(false);
  });

  test("cpt_code is optional", () => {
    const parsed = BillingError.safeParse({
      line_quote: "Current Balance Due $6,371.50",
      page_number: 1,
      error_type: "balance_billing",
      confidence: "high",
      dollar_impact: 3812,
      evidence: "Bill exceeds EOB patient responsibility by $3,812.",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("BillMetadata schema", () => {
  test("accepts all nulls (no crash during early analyzer turns)", () => {
    const parsed = BillMetadata.safeParse({
      patient_name: null,
      provider_name: null,
      provider_billing_address: null,
      claim_number: null,
      date_of_service: null,
      insurer_name: null,
      eob_patient_responsibility: null,
      bill_current_balance_due: null,
      account_number: null,
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts mixed nulls and strings", () => {
    const parsed = BillMetadata.safeParse({
      patient_name: "Jane Doe",
      provider_name: "Hospital X",
      provider_billing_address: null,
      claim_number: "CL-123",
      date_of_service: "03/14/2026",
      insurer_name: "BlueExample",
      eob_patient_responsibility: 2759.5,
      bill_current_balance_due: 6371.5,
      account_number: null,
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects missing keys (all fields required, value may be null)", () => {
    // patient_name missing entirely
    const parsed = BillMetadata.safeParse({
      provider_name: null,
      provider_billing_address: null,
      claim_number: null,
      date_of_service: null,
      insurer_name: null,
      eob_patient_responsibility: null,
      bill_current_balance_due: null,
      account_number: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("HIGH_CONFIDENCE_TYPES", () => {
  test("includes exactly duplicate/denied_service/balance_billing", () => {
    expect(HIGH_CONFIDENCE_TYPES).toEqual([
      "duplicate",
      "denied_service",
      "balance_billing",
    ]);
  });
});

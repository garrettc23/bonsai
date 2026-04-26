/**
 * Pure-function tests for the multi-category baseline derivation. These
 * pin the rules that drive the audit/approve-time offer hunt — if a
 * pattern stops matching here, the comparison tab silently goes empty.
 *
 * Run: bun test test/derive-offer-baselines.test.ts
 */
import { describe, expect, test } from "bun:test";
import { deriveOfferBaselines } from "../src/lib/derive-offer-baselines.ts";
import type { AnalyzerResult } from "../src/types.ts";

function audit(meta: Partial<AnalyzerResult["metadata"]>, errors: Array<{ line_quote: string }> = []): AnalyzerResult {
  return {
    metadata: {
      patient_name: null,
      provider_name: null,
      provider_billing_address: null,
      claim_number: null,
      date_of_service: null,
      insurer_name: null,
      eob_patient_responsibility: null,
      bill_current_balance_due: null,
      account_number: null,
      bill_kind: "medical",
      ...meta,
    },
    errors: errors.map((e) => ({
      line_quote: e.line_quote,
      page_number: 1,
      error_type: "upcoding",
      confidence: "high",
      dollar_impact: 0,
      evidence: "test fixture",
    })),
    summary: {
      high_confidence_total: 0,
      worth_reviewing_total: 0,
      bill_total_disputed: 0,
      headline: "Test fixture analyzer result.",
    },
    grounding_failures: [],
    meta: { model: "test", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

describe("deriveOfferBaselines", () => {
  test("Walgreens medical bill yields a prescription baseline", () => {
    const result = deriveOfferBaselines(
      audit({ provider_name: "Walgreens Pharmacy #4321", bill_current_balance_due: 120, bill_kind: "medical" }),
    );
    expect(result.length).toBe(1);
    expect(result[0].category).toBe("prescription");
    expect(result[0].current_provider).toBe("Walgreens Pharmacy #4321");
    expect(result[0].current_price).toBe(120);
  });

  test("Quest Diagnostics yields a lab_work baseline", () => {
    const result = deriveOfferBaselines(
      audit({ provider_name: "Quest Diagnostics", bill_current_balance_due: 380, bill_kind: "medical" }),
    );
    expect(result.length).toBe(1);
    expect(result[0].category).toBe("lab_work");
  });

  test("Hospital + balance > 1500 yields a hospital_bill baseline", () => {
    const result = deriveOfferBaselines(
      audit({ provider_name: "Stanford Hospital", bill_current_balance_due: 12000, bill_kind: "medical" }),
    );
    expect(result.find((b) => b.category === "hospital_bill")).toBeDefined();
  });

  test("Hospital + balance < 1500 does NOT yield a hospital_bill baseline", () => {
    const result = deriveOfferBaselines(
      audit({ provider_name: "Mercy Hospital", bill_current_balance_due: 600, bill_kind: "medical" }),
    );
    expect(result.find((b) => b.category === "hospital_bill")).toBeUndefined();
  });

  test("bill_kind=insurance yields an insurance_plan baseline", () => {
    const result = deriveOfferBaselines(
      audit({ provider_name: "Aetna", bill_current_balance_due: 450, bill_kind: "insurance" }),
    );
    expect(result.find((b) => b.category === "insurance_plan")).toBeDefined();
  });

  test("bill_kind=utility yields no baseline (no current OfferCategory)", () => {
    const result = deriveOfferBaselines(
      audit({ provider_name: "PG&E", bill_current_balance_due: 240, bill_kind: "utility" }),
    );
    expect(result).toEqual([]);
  });

  test("missing provider_name yields no baseline", () => {
    const result = deriveOfferBaselines(audit({ provider_name: null, bill_current_balance_due: 500 }));
    expect(result).toEqual([]);
  });

  test("zero or negative balance yields no baseline", () => {
    const result = deriveOfferBaselines(
      audit({ provider_name: "Walgreens", bill_current_balance_due: 0, bill_kind: "medical" }),
    );
    expect(result).toEqual([]);
  });

  test("drug name in errors[].line_quote adds a prescription baseline even without pharmacy provider", () => {
    const result = deriveOfferBaselines(
      audit(
        { provider_name: "Generic Medical Group", bill_current_balance_due: 250, bill_kind: "medical" },
        [{ line_quote: "atorvastatin 20mg tablet 30 day supply" }],
      ),
    );
    expect(result.find((b) => b.category === "prescription")).toBeDefined();
  });

  test("dedupes when both provider and error patterns match the same category", () => {
    const result = deriveOfferBaselines(
      audit(
        { provider_name: "CVS Pharmacy", bill_current_balance_due: 80, bill_kind: "medical" },
        [{ line_quote: "lisinopril 10mg tablet" }],
      ),
    );
    const prescriptionBaselines = result.filter((b) => b.category === "prescription");
    expect(prescriptionBaselines.length).toBe(1);
  });
});

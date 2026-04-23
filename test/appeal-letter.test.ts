/**
 * Tests for the deterministic appeal letter generator. These are the
 * guardrails that catch drift: placeholders when data is missing, NSA
 * clause only when balance_billing exists, verbatim line_quote preserved.
 *
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { generateAppealLetter } from "../src/appeal-letter.ts";
import type { AnalyzerResult, BillMetadata } from "../src/types.ts";

function fakeResult(overrides: {
  metadata?: Partial<BillMetadata>;
  errors?: AnalyzerResult["errors"];
  high_confidence_total?: number;
} = {}): AnalyzerResult {
  const baseMeta: BillMetadata = {
    patient_name: "Jane Q. Doe",
    provider_name: "ST. SYNTHETIC REGIONAL HOSPITAL",
    provider_billing_address: "1200 Example Parkway, Mountain View, CA 94043",
    claim_number: "CL-2026-008821134",
    date_of_service: "03/14/2026",
    insurer_name: "BlueExample PPO",
    eob_patient_responsibility: 2759.5,
    bill_current_balance_due: 6371.5,
    account_number: "2045-887291",
  };
  return {
    metadata: { ...baseMeta, ...(overrides.metadata ?? {}) },
    errors: overrides.errors ?? [],
    summary: {
      high_confidence_total: overrides.high_confidence_total ?? 0,
      worth_reviewing_total: 0,
      bill_total_disputed: overrides.high_confidence_total ?? 0,
      headline: "fake",
    },
    grounding_failures: [],
    meta: { model: "fake", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

describe("generateAppealLetter — placeholders", () => {
  test("returns empty placeholders when metadata is complete", () => {
    const letter = generateAppealLetter(fakeResult());
    expect(letter.used_placeholders).toEqual([]);
  });

  test("flags null fields as placeholders", () => {
    const letter = generateAppealLetter(
      fakeResult({
        metadata: {
          provider_name: null,
          claim_number: null,
          eob_patient_responsibility: null,
        },
      }),
    );
    expect(letter.used_placeholders).toContain("PROVIDER NAME");
    expect(letter.used_placeholders).toContain("CLAIM NUMBER");
    expect(letter.used_placeholders).toContain("EOB PATIENT RESPONSIBILITY");
  });

  test("treats empty-string metadata as missing", () => {
    const letter = generateAppealLetter(
      fakeResult({ metadata: { patient_name: "" as string } }),
    );
    expect(letter.used_placeholders).toContain("PATIENT NAME");
    expect(letter.markdown).toContain("[PATIENT NAME]");
  });
});

describe("generateAppealLetter — NSA clause", () => {
  test("omits No Surprises Act paragraph when no balance_billing finding", () => {
    const letter = generateAppealLetter(
      fakeResult({
        errors: [
          {
            line_quote: "dup row here with cpt x",
            page_number: 1,
            error_type: "duplicate",
            confidence: "high",
            dollar_impact: 468,
            evidence: "EOB says only one unit allowed",
          },
        ],
        high_confidence_total: 468,
      }),
    );
    expect(letter.markdown).not.toContain("No Surprises Act");
    expect(letter.markdown).not.toContain("## Legal basis");
  });

  test("includes NSA paragraph when balance_billing finding present", () => {
    const letter = generateAppealLetter(
      fakeResult({
        errors: [
          {
            line_quote: "Current Balance Due $6,371.50",
            page_number: 1,
            error_type: "balance_billing",
            confidence: "high",
            dollar_impact: 3612,
            evidence: "Bill charges $6,371.50 but EOB patient responsibility is $2,759.50.",
          },
        ],
        high_confidence_total: 3612,
      }),
    );
    expect(letter.markdown).toContain("No Surprises Act");
    expect(letter.markdown).toContain("45 CFR");
    expect(letter.markdown).toContain("## Legal basis");
  });
});

describe("generateAppealLetter — verbatim quotes", () => {
  test("preserves line_quote exactly as provided", () => {
    const quote = "| 3 | 03/14/2026 | 71046 | Chest X-ray, 2 views | 1 | $468.00 |";
    const letter = generateAppealLetter(
      fakeResult({
        errors: [
          {
            line_quote: quote,
            page_number: 1,
            error_type: "duplicate",
            confidence: "high",
            dollar_impact: 468,
            evidence: "same CPT charged twice",
          },
        ],
        high_confidence_total: 468,
      }),
    );
    expect(letter.markdown).toContain(quote);
  });

  test("skips worth_reviewing findings in the body", () => {
    const letter = generateAppealLetter(
      fakeResult({
        errors: [
          {
            line_quote: "some worth-reviewing line",
            page_number: 1,
            error_type: "overcharge",
            confidence: "worth_reviewing",
            dollar_impact: 500,
            evidence: "above medicare benchmark",
          },
        ],
        high_confidence_total: 0,
      }),
    );
    expect(letter.markdown).not.toContain("some worth-reviewing line");
    // "No high-confidence findings" warning should appear when list is empty
    expect(letter.markdown).toContain("No high-confidence findings");
  });
});

describe("generateAppealLetter — dollar formatting", () => {
  test("formats dollar amounts with thousands separator and 2 decimals", () => {
    const letter = generateAppealLetter(
      fakeResult({ high_confidence_total: 3812 }),
    );
    expect(letter.markdown).toContain("$3,812.00");
  });

  test("renders [AMOUNT] when eob_patient_responsibility is null", () => {
    const letter = generateAppealLetter(
      fakeResult({ metadata: { eob_patient_responsibility: null } }),
    );
    expect(letter.markdown).toContain("[AMOUNT]");
  });
});

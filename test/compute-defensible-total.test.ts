/**
 * Unit tests for the overlap-aware total. This math is the defense against
 * Claude's most common arithmetic mistake (summing balance_billing + the
 * line items that balance_billing already subsumes).
 *
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { computeDefensibleTotal } from "../src/analyzer.ts";
import type { BillingError } from "../src/types.ts";

function err(
  type: BillingError["error_type"],
  amount: number,
  confidence: BillingError["confidence"] = "high",
  cpt?: string,
): BillingError {
  return {
    line_quote: "FAKE QUOTE ".repeat(2),
    page_number: 1,
    error_type: type,
    confidence,
    dollar_impact: amount,
    evidence: "fake evidence for test fixture",
    ...(cpt ? { cpt_code: cpt } : {}),
  };
}

describe("computeDefensibleTotal", () => {
  test("sums all HIGH when no balance_billing finding", () => {
    const errors = [
      err("duplicate", 468),
      err("denied_service", 1680),
      err("denied_service", 48),
    ];
    expect(computeDefensibleTotal(errors)).toBe(2196);
  });

  test("ignores worth_reviewing findings in total", () => {
    const errors = [
      err("duplicate", 468),
      err("eob_mismatch", 9999, "worth_reviewing"),
      err("denied_service", 100),
    ];
    expect(computeDefensibleTotal(errors)).toBe(568);
  });

  test("balance_billing subsumes smaller line items (envelope rule)", () => {
    // 5 denial lines totaling $3,590 inside a $3,812 balance-billing envelope.
    // Correct answer: $3,812, not $7,402.
    const errors = [
      err("balance_billing", 3812),
      err("duplicate", 468),
      err("denied_service", 1680),
      err("denied_service", 48),
      err("denied_service", 1240),
      err("denied_service", 154),
    ];
    expect(computeDefensibleTotal(errors)).toBe(3812);
  });

  test("takes max(balance_billing, sum_other) when other exceeds envelope", () => {
    // If the agent over-reports individual lines beyond the envelope, the
    // defensible total is the larger number (we take the most aggressive
    // defensible position consistent with the EOB evidence).
    const errors = [
      err("balance_billing", 1000),
      err("duplicate", 800),
      err("denied_service", 900),
    ];
    expect(computeDefensibleTotal(errors)).toBe(1700);
  });

  test("takes max of multiple balance_billing findings", () => {
    const errors = [
      err("balance_billing", 2500),
      err("balance_billing", 3812),
      err("duplicate", 100),
    ];
    // max(max(2500, 3812), sum_non_bb=100) = 3812
    expect(computeDefensibleTotal(errors)).toBe(3812);
  });

  test("empty errors => 0", () => {
    expect(computeDefensibleTotal([])).toBe(0);
  });

  test("only worth_reviewing => 0 (never defensible)", () => {
    const errors = [
      err("eob_mismatch", 9999, "worth_reviewing"),
      err("overcharge", 5000, "worth_reviewing"),
    ];
    expect(computeDefensibleTotal(errors)).toBe(0);
  });
});

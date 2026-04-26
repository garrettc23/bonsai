/**
 * Channel-routing rules.
 *
 * Auto picks based on what contact channels are on file (email/phone),
 * not on bill amount or finding type. Email-first whenever email is
 * available; voice when only phone; persistent (email → 24wh idle →
 * voice) when both are present.
 *
 * Explicit caller choices (email/voice/persistent) win over the auto
 * heuristic.
 */
import { describe, expect, test } from "bun:test";
import { chooseChannel } from "../src/orchestrator.ts";
import type { AnalyzerResult, BillingError, BillMetadata } from "../src/types.ts";

function fakeAnalyzer(errors: BillingError[], highTotal: number): AnalyzerResult {
  const meta: BillMetadata = {
    patient_name: "X", provider_name: "Y", provider_billing_address: null,
    claim_number: null, date_of_service: null, insurer_name: null,
    eob_patient_responsibility: null, bill_current_balance_due: null, account_number: null,
  };
  return {
    metadata: meta,
    errors,
    summary: {
      high_confidence_total: highTotal,
      worth_reviewing_total: 0,
      bill_total_disputed: highTotal,
      headline: "fake",
    },
    grounding_failures: [],
    meta: { model: "fake", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

function err(type: BillingError["error_type"], dollars: number): BillingError {
  return {
    line_quote: "some quote here",
    page_number: 1,
    error_type: type,
    confidence: "high",
    dollar_impact: dollars,
    evidence: "fake evidence",
  };
}

const a = fakeAnalyzer([err("balance_billing", 5000)], 5000);

describe("chooseChannel — explicit overrides", () => {
  test("explicit email is honored regardless of contact", () => {
    expect(chooseChannel(a, "email", { hasEmail: false, hasPhone: false }).chosen).toBe("email");
    expect(chooseChannel(a, "email", { hasEmail: true, hasPhone: true }).chosen).toBe("email");
  });

  test("explicit voice is honored regardless of contact", () => {
    expect(chooseChannel(a, "voice", { hasEmail: true, hasPhone: false }).chosen).toBe("voice");
  });

  test("explicit persistent is honored when both contacts on file", () => {
    expect(chooseChannel(a, "persistent", { hasEmail: true, hasPhone: true }).chosen).toBe("persistent");
  });
});

describe("chooseChannel — auto routing by contact", () => {
  test("email only → email", () => {
    const r = chooseChannel(a, "auto", { hasEmail: true, hasPhone: false });
    expect(r.chosen).toBe("email");
  });

  test("phone only → voice", () => {
    const r = chooseChannel(a, "auto", { hasEmail: false, hasPhone: true });
    expect(r.chosen).toBe("voice");
  });

  test("both on file → persistent", () => {
    const r = chooseChannel(a, "auto", { hasEmail: true, hasPhone: true });
    expect(r.chosen).toBe("persistent");
    expect(r.reason).toContain("24 working hours");
  });

  test("neither on file → throws (caller must gate)", () => {
    expect(() => chooseChannel(a, "auto", { hasEmail: false, hasPhone: false })).toThrow(
      /no contact channel/i,
    );
  });
});

describe("chooseChannel — old BB-$1500 rule is dead", () => {
  test("balance_billing $5,000 with both contacts → persistent (NOT voice)", () => {
    const big = fakeAnalyzer([err("balance_billing", 5000)], 5000);
    expect(chooseChannel(big, "auto", { hasEmail: true, hasPhone: true }).chosen).toBe(
      "persistent",
    );
  });

  test("non-BB $5,000 with email only → email (no amount-based override)", () => {
    const big = fakeAnalyzer([err("duplicate", 2000), err("denied_service", 3000)], 5000);
    expect(chooseChannel(big, "auto", { hasEmail: true, hasPhone: false }).chosen).toBe("email");
  });
});

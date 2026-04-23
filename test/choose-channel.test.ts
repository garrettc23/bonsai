/**
 * Channel-routing heuristic tests. The rule:
 *   explicit email/voice → honored verbatim
 *   auto + balance_billing + HIGH ≥ $1,500 → voice (phone converts better on NSA)
 *   auto + everything else → email (lower friction, leaves paper trail)
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

describe("chooseChannel", () => {
  test("honors explicit email", () => {
    const a = fakeAnalyzer([err("balance_billing", 5000)], 5000);
    expect(chooseChannel(a, "email").chosen).toBe("email");
  });

  test("honors explicit voice even with no findings", () => {
    const a = fakeAnalyzer([], 0);
    expect(chooseChannel(a, "voice").chosen).toBe("voice");
  });

  test("auto + balance_billing above threshold → voice", () => {
    const a = fakeAnalyzer([err("balance_billing", 3812)], 3812);
    const r = chooseChannel(a, "auto");
    expect(r.chosen).toBe("voice");
    expect(r.reason).toContain("Balance-billing");
  });

  test("auto + balance_billing below $1,500 → email", () => {
    const a = fakeAnalyzer([err("balance_billing", 800)], 800);
    expect(chooseChannel(a, "auto").chosen).toBe("email");
  });

  test("auto + no balance_billing → email regardless of total", () => {
    const a = fakeAnalyzer(
      [err("duplicate", 2000), err("denied_service", 3000)],
      5000,
    );
    expect(chooseChannel(a, "auto").chosen).toBe("email");
  });

  test("auto + zero findings → email", () => {
    const a = fakeAnalyzer([], 0);
    expect(chooseChannel(a, "auto").chosen).toBe("email");
  });

  test("explicit choice wins over heuristic", () => {
    // Would route to voice under auto, but user said email
    const a = fakeAnalyzer([err("balance_billing", 10000)], 10000);
    expect(chooseChannel(a, "email").chosen).toBe("email");
  });
});

/**
 * Phone-only contact routes to voice.
 *
 * Corollary of the chooseChannel rules: when the only contact channel on
 * file is a phone number, auto must pick voice — not email, not
 * persistent. Regression guard for users who add only a phone in the
 * Contact tab.
 */
import { describe, expect, test } from "bun:test";
import { chooseChannel } from "../src/orchestrator.ts";
import type { AnalyzerResult, BillingError, BillMetadata } from "../src/types.ts";

function fakeAnalyzer(): AnalyzerResult {
  const meta: BillMetadata = {
    patient_name: "X", provider_name: "Y", provider_billing_address: null,
    claim_number: null, date_of_service: null, insurer_name: null,
    eob_patient_responsibility: null, bill_current_balance_due: null, account_number: null,
  };
  const errors: BillingError[] = [];
  return {
    metadata: meta,
    errors,
    summary: { high_confidence_total: 0, worth_reviewing_total: 0, bill_total_disputed: 0, headline: "fake" },
    grounding_failures: [],
    meta: { model: "fake", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

describe("phone-only routing", () => {
  test("auto + phone-only → voice", () => {
    const r = chooseChannel(fakeAnalyzer(), "auto", { hasEmail: false, hasPhone: true });
    expect(r.chosen).toBe("voice");
    expect(r.reason.toLowerCase()).toContain("phone");
  });

  test("auto + phone-only does NOT route to email", () => {
    const r = chooseChannel(fakeAnalyzer(), "auto", { hasEmail: false, hasPhone: true });
    expect(r.chosen).not.toBe("email");
  });

  test("auto + phone-only does NOT route to persistent", () => {
    const r = chooseChannel(fakeAnalyzer(), "auto", { hasEmail: false, hasPhone: true });
    expect(r.chosen).not.toBe("persistent");
  });
});

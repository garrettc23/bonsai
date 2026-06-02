/**
 * Pins the documented "analyzer is medical-only" contract (src/types.ts:106).
 *
 * Today the grounded analyzer runs only on medical bills. Non-medical bills
 * carry no high-confidence findings, and the negotiation playbook must fall
 * back to GOODWILL MODE (retention / discount / waiver) instead of citing
 * grounded disputed charges it doesn't have.
 *
 * This is the branch Workstream B will change when it adds per-category
 * rule-packs, so we lock the current behavior first. The observable seam is
 * the voice agent prompt built by generateAgentConfig: with no HIGH findings
 * it must produce goodwill language, not a grounded dispute.
 *
 * Pure prompt-construction; no network, no model.
 *
 * Run: bun test test/non-medical-skips-analyzer.test.ts
 */
import { describe, expect, test } from "bun:test";
import { generateAgentConfig } from "../src/voice/agent-config.ts";
import type { AnalyzerResult, BillKind, BillingError } from "../src/types.ts";

function emptyMetadata(over: Partial<AnalyzerResult["metadata"]> = {}): AnalyzerResult["metadata"] {
  return {
    patient_name: null,
    provider_name: null,
    provider_billing_address: null,
    claim_number: null,
    date_of_service: null,
    insurer_name: null,
    eob_patient_responsibility: null,
    bill_current_balance_due: 240,
    account_number: "ACCT-9",
    bill_kind: "medical",
    ...over,
  };
}

function analyzerResult(opts: {
  bill_kind: BillKind;
  errors?: BillingError[];
}): AnalyzerResult {
  const errors = opts.errors ?? [];
  const high = errors.filter((e) => e.confidence === "high");
  return {
    metadata: emptyMetadata({ bill_kind: opts.bill_kind }),
    errors,
    summary: {
      high_confidence_total: high.reduce((a, e) => a + e.dollar_impact, 0),
      worth_reviewing_total: 0,
      bill_total_disputed: high.reduce((a, e) => a + e.dollar_impact, 0),
      headline: "test fixture summary",
    },
    grounding_failures: [],
    meta: { model: "test", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

function promptFor(result: AnalyzerResult, bill_kind: BillKind): string {
  const cfg = generateAgentConfig({
    result,
    bill_kind,
    webhook_base_url: "https://bonsai.test/voice-webhook",
    webhook_secret: "test-secret",
    final_acceptable_floor: 100,
  });
  return cfg.conversation_config.agent.prompt.prompt;
}

describe("non-medical bill → goodwill mode (no grounded analyzer findings)", () => {
  test("a utility bill with no findings runs in goodwill mode", () => {
    const prompt = promptFor(analyzerResult({ bill_kind: "utility" }), "utility");
    expect(prompt).toContain("goodwill mode");
    expect(prompt).toContain("negotiate a lower amount");
    // Identity is the generic billing assistant, not a medical patient advocate.
    expect(prompt).toContain("billing assistant");
    expect(prompt).not.toContain("patient advocate");
  });

  test.each(["telecom", "subscription", "insurance", "financial", "other"] as const)(
    "%s bill with no findings → goodwill, never a grounded dispute",
    (kind) => {
      const prompt = promptFor(analyzerResult({ bill_kind: kind }), kind);
      expect(prompt).toContain("There are no grounded findings");
      expect(prompt).not.toContain("Disputed charges (grounded)");
    },
  );
});

describe("medical bill with findings → grounded dispute (the contrast)", () => {
  test("medical + HIGH finding cites grounded charges and patient-advocate identity", () => {
    const medical = analyzerResult({
      bill_kind: "medical",
      errors: [
        {
          line_quote: "Current Balance Due",
          page_number: 1,
          error_type: "balance_billing",
          confidence: "high",
          dollar_impact: 3812,
          evidence: "Bill balance exceeds EOB-stated patient responsibility.",
        },
      ],
    });
    const prompt = promptFor(medical, "medical");
    expect(prompt).toContain("Disputed charges (grounded)");
    expect(prompt).toContain("dispute and resolve charges");
    expect(prompt).toContain("patient advocate");
    expect(prompt).not.toContain("goodwill mode");
  });
});

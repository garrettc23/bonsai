/**
 * Tests for the pre-dial voice fact-check gate (Workstream C).
 *
 * A live phone agent can't redraft mid-call, so before placing a REAL call
 * we verify the grounded claims it's scripted to speak survive cross-modal
 * fact-check — and refuse to dial if they don't. This pins:
 *
 *   - OFF by default (BONSAI_CROSSMODAL unset) → gate is a no-op (skipped).
 *   - ON + verifier says clean → dial allowed.
 *   - ON + verifier flags a fabrication → dial refused, violation surfaced.
 *
 * Deterministic: the verifier runner is injected (no OpenAI call).
 *
 * Run: bun test test/voice-fact-check.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { voiceClaimsFactCheck } from "../src/server/voice-dial.ts";
import type { AnalyzerResult } from "../src/types.ts";
import type { LLMResponse, ProviderRunners } from "../src/llm/provider.ts";

function analyzerWithHighFinding(): AnalyzerResult {
  return {
    metadata: {
      patient_name: "Jane Q. Doe",
      provider_name: "ST. SYNTHETIC REGIONAL HOSPITAL",
      provider_billing_address: null,
      claim_number: "CLM-9",
      date_of_service: "03/14/2026",
      insurer_name: null,
      eob_patient_responsibility: 100,
      bill_current_balance_due: 3812,
      account_number: "ACCT-1",
      bill_kind: "medical",
    },
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
    summary: {
      high_confidence_total: 3812,
      worth_reviewing_total: 0,
      bill_total_disputed: 3812,
      headline: "Found $3,812 in high-confidence billing errors.",
    },
    grounding_failures: [],
    meta: { model: "test", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

function openaiRunner(passed: boolean, violations: unknown[] = []): ProviderRunners {
  return {
    openai: async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: { name: "fact_check_report", input: { passed, violations } },
    }),
  };
}

const BASE = {
  webhook_base_url: "https://bonsai.test/voice-webhook",
  webhook_secret: "secret",
  account_holder_name: null,
  final_acceptable_floor: 100,
};

afterEach(() => {
  delete process.env.BONSAI_CROSSMODAL;
});

describe("voiceClaimsFactCheck", () => {
  test("no-op when BONSAI_CROSSMODAL is off (gate passes, never calls verifier)", async () => {
    delete process.env.BONSAI_CROSSMODAL;
    let called = false;
    const runners: ProviderRunners = {
      openai: async () => {
        called = true;
        return { text: "", tool_use: { name: "fact_check_report", input: { passed: false, violations: [] } } };
      },
    };
    const r = await voiceClaimsFactCheck({ analyzer: analyzerWithHighFinding(), ...BASE }, runners);
    expect(r.ok).toBe(true);
    expect(called).toBe(false);
  });

  test("allows the dial when the verifier reports the claims are clean", async () => {
    process.env.BONSAI_CROSSMODAL = "1";
    const r = await voiceClaimsFactCheck(
      { analyzer: analyzerWithHighFinding(), ...BASE },
      openaiRunner(true),
    );
    expect(r.ok).toBe(true);
  });

  test("refuses the dial when the verifier flags a fabricated claim", async () => {
    process.env.BONSAI_CROSSMODAL = "1";
    const r = await voiceClaimsFactCheck(
      { analyzer: analyzerWithHighFinding(), ...BASE },
      openaiRunner(false, [{ kind: "fabricated", detail: "Claim number CLM-9 does not appear in the bill." }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain("fabricated");
      expect(r.detail).toContain("CLM-9");
    }
  });
});

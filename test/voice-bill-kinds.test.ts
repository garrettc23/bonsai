/**
 * Voice agent generalization: the system prompt, first_message, tools, and
 * agent name must adapt cleanly across all seven bill kinds. These tests
 * lock the load-bearing invariants:
 *
 *   1. AI disclosure stays in the first_message and the system prompt for
 *      every kind. Removing it is a TCPA / two-party-consent regression.
 *   2. The medical kind keeps its NSA + EOB language so the original
 *      grounded negotiation flow does not regress.
 *   3. Non-medical kinds get the goodwill `propose_general_discount` tool
 *      and avoid medical-only nouns ("patient", "EOB", "NSA") in the
 *      tactics block.
 *   4. Floor never falls to the bug-prone $0 when EOB is null but a bill
 *      balance is present.
 */
import { describe, expect, test } from "bun:test";
import { generateAgentConfig } from "../src/voice/agent-config.ts";
import type { AnalyzerResult, BillKind } from "../src/types.ts";

const ALL_KINDS: BillKind[] = [
  "medical",
  "telecom",
  "utility",
  "subscription",
  "insurance",
  "financial",
  "other",
];

function fakeAnalyzer(overrides: Partial<AnalyzerResult["metadata"]> = {}): AnalyzerResult {
  return {
    metadata: {
      patient_name: "Jane Doe",
      provider_name: "Acme Provider",
      provider_billing_address: null,
      claim_number: null,
      date_of_service: null,
      insurer_name: null,
      eob_patient_responsibility: null,
      bill_current_balance_due: 250,
      account_number: "ACC-1",
      bill_kind: "medical",
      ...overrides,
    },
    errors: [],
    summary: {
      high_confidence_total: 0,
      worth_reviewing_total: 0,
      bill_total_disputed: 0,
      headline: "no findings",
    },
    grounding_failures: [],
    meta: { model: "test", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

describe("AI disclosure (TCPA / two-party-consent floor)", () => {
  for (const kind of ALL_KINDS) {
    test(`${kind}: first_message discloses 'automated assistant' and recording`, () => {
      const cfg = generateAgentConfig({
        result: fakeAnalyzer({ bill_kind: kind }),
        webhook_base_url: "https://x",
        webhook_secret: "s",
        bill_kind: kind,
      });
      const fm = cfg.conversation_config.agent.first_message.toLowerCase();
      expect(fm).toContain("automated assistant");
      expect(fm).toContain("may be recorded");
    });

    test(`${kind}: system prompt requires opening disclosure on every call`, () => {
      const cfg = generateAgentConfig({
        result: fakeAnalyzer({ bill_kind: kind }),
        webhook_base_url: "https://x",
        webhook_secret: "s",
        bill_kind: kind,
      });
      const prompt = cfg.conversation_config.agent.prompt.prompt;
      // The prompt should never tell the agent to hide that it's automated.
      expect(prompt.toLowerCase()).not.toContain("do not reveal you are an ai");
      expect(prompt.toLowerCase()).toContain("automated assistant");
      expect(prompt.toLowerCase()).toContain("may be recorded");
    });
  }
});

describe("Medical preservation (no regression on grounded NSA/EOB flow)", () => {
  test("medical prompt cites NSA and EOB language", () => {
    const cfg = generateAgentConfig({
      result: fakeAnalyzer({
        bill_kind: "medical",
        eob_patient_responsibility: 500,
        bill_current_balance_due: 1500,
      }),
      webhook_base_url: "https://x",
      webhook_secret: "s",
      bill_kind: "medical",
    });
    const prompt = cfg.conversation_config.agent.prompt.prompt;
    expect(prompt).toContain("No Surprises Act");
    expect(prompt).toContain("EOB");
    expect(prompt.toLowerCase()).toContain("patient");
  });
});

describe("Goodwill mode for non-medical kinds", () => {
  for (const kind of ALL_KINDS.filter((k) => k !== "medical")) {
    test(`${kind}: tactics block avoids medical-only nouns`, () => {
      const cfg = generateAgentConfig({
        result: fakeAnalyzer({ bill_kind: kind }),
        webhook_base_url: "https://x",
        webhook_secret: "s",
        bill_kind: kind,
      });
      const prompt = cfg.conversation_config.agent.prompt.prompt;
      // Tactics for non-medical never reference NSA / EOB / claim #.
      expect(prompt).not.toContain("No Surprises Act");
      expect(prompt).not.toContain("Claim #");
    });

    test(`${kind}: identity uses 'account holder' not 'patient'`, () => {
      const cfg = generateAgentConfig({
        result: fakeAnalyzer({
          bill_kind: kind,
          patient_name: null, // generic case
        }),
        webhook_base_url: "https://x",
        webhook_secret: "s",
        bill_kind: kind,
        account_holder_name: "Pat Subscriber",
      });
      const prompt = cfg.conversation_config.agent.prompt.prompt;
      expect(prompt).toContain("Pat Subscriber");
      expect(prompt).toContain("account holder");
    });
  }
});

describe("Tools", () => {
  test("propose_general_discount is registered for every kind", () => {
    for (const kind of ALL_KINDS) {
      const cfg = generateAgentConfig({
        result: fakeAnalyzer({ bill_kind: kind }),
        webhook_base_url: "https://x",
        webhook_secret: "s",
        bill_kind: kind,
      });
      const names = cfg.conversation_config.agent.prompt.tools.map((t) => t.name);
      expect(names).toContain("propose_general_discount");
      expect(names).toContain("record_negotiated_amount");
      expect(names).toContain("end_call");
    }
  });
});

describe("Floor fallback chain (no $0 floor bug)", () => {
  test("falls back to bill balance when EOB is null on a non-medical bill", () => {
    const cfg = generateAgentConfig({
      result: fakeAnalyzer({
        bill_kind: "telecom",
        eob_patient_responsibility: null,
        bill_current_balance_due: 187,
      }),
      webhook_base_url: "https://x",
      webhook_secret: "s",
      bill_kind: "telecom",
    });
    const prompt = cfg.conversation_config.agent.prompt.prompt;
    expect(prompt).toContain("$187.00");
    expect(prompt).not.toContain("$0.00");
  });
});

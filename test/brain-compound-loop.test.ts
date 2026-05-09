/**
 * The compound-loop closing test.
 *
 * Phase 4 wrote provider brain pages on thread close. Phase 5a reads
 * them back into the draft-reply system prompt. This test proves the
 * loop is wired end-to-end:
 *
 *   1. Seed a brain page for "Aetna" directly via upsertBrain.
 *   2. Run stepNegotiation with provider_name = "Aetna" in analyzer.
 *   3. Assert the system prompt captured by the mock Anthropic call
 *      contains the seeded compiled_truth — i.e., the agent saw the
 *      cross-user playbook.
 *
 * Negative test: provider with no brain page → system prompt has no
 * playbook block.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest } from "../src/lib/db.ts";
import { MockEmailClient } from "../src/clients/email-mock.ts";
import {
  startNegotiation,
  stepNegotiation,
  type NegotiationState,
} from "../src/negotiate-email.ts";
import { upsertBrain } from "../src/brain/provider-brain.ts";
import type { AnalyzerResult } from "../src/types.ts";

const TEST_DB_DIR = join(tmpdir(), `bonsai-loop-${process.pid}-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, "bonsai.db");

function nukeDb(): void {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  _resetDbForTest();
}

function fixtureAnalyzer(providerName: string): AnalyzerResult {
  return {
    metadata: {
      patient_name: "Test Patient",
      provider_name: providerName,
      provider_billing_address: "123 Main St, Springfield, IL 62701",
      claim_number: "CLM-001",
      date_of_service: "2026-03-01",
      insurer_name: "Acme Insurance",
      eob_patient_responsibility: 100,
      bill_current_balance_due: 1000,
      account_number: "ACCT-1",
      bill_kind: "medical",
    },
    errors: [
      {
        line_quote: "Balance billing $900",
        error_type: "balance_billing",
        confidence: "high",
        dollar_impact: 900,
        evidence: "EOB shows in-network status; NSA prohibits balance billing.",
      },
    ],
    summary: {
      high_confidence_total: 900,
      worth_reviewing_total: 0,
      bill_total_disputed: 900,
      headline: "Found $900 in high-confidence billing errors.",
    },
    grounding_failures: [],
    meta: {
      model: "claude-opus-4-7",
      input_tokens: 0,
      output_tokens: 0,
      elapsed_ms: 0,
      tool_turns: 0,
    },
  };
}

interface MockResponse {
  stop_reason: "end_turn" | "tool_use";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
}

function mockAnthropic(scriptedResponses: MockResponse[]): {
  client: Anthropic;
  capturedSystem: string[];
} {
  const queue = [...scriptedResponses];
  const captured: string[] = [];
  const client = {
    messages: {
      create: async (req: { system: string }) => {
        captured.push(req.system);
        const next = queue.shift();
        if (!next) throw new Error("Mock Anthropic: no more scripted responses");
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, capturedSystem: captured };
}

let tmpDir: string;

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB_PATH;
  process.env.BONSAI_BRAIN_HMAC_KEY = "loop-test-hmac-fortyplus-characters-required-here";
  nukeDb();
});

afterAll(() => {
  nukeDb();
  delete process.env.BONSAI_DB_PATH;
  delete process.env.BONSAI_BRAIN_HMAC_KEY;
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bonsai-loop-"));
  nukeDb();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeStartedState(providerName: string): Promise<{ state: NegotiationState; client: MockEmailClient }> {
  const client = new MockEmailClient(tmpDir);
  const { state } = await startNegotiation({
    analyzer: fixtureAnalyzer(providerName),
    client,
    user_email: "patient@example.com",
    provider_email: "billing@aetna.example",
    final_acceptable_floor: 100,
  });
  return { state, client };
}

describe("compound loop: brain write → brain read into draft-reply prompt", () => {
  test("seeded brain page is injected into the next system prompt", async () => {
    // Seed a brain page as if a previous user already negotiated this
    // provider. Pattern-level, no PII — passes the regex gate.
    upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth:
        "Aetna often agrees to the EOB amount on the first formal written dispute. Lead with the EOB citation and a deadline.",
      events: [
        {
          kind: "concession_unlock",
          detail: "Citing the EOB unlocked full adjustment in one round",
        },
      ],
      thread_id: "prior_thread",
      user_id: "prior_user",
    });

    const { state, client } = await makeStartedState("Aetna");
    await client.ingestInbound({
      from: "billing@aetna.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We received your appeal.",
      thread_id: state.thread_id,
    });
    const { client: anth, capturedSystem } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_email",
            input: {
              subject: "Re: Re: Appeal",
              body_text:
                "Per the EOB, patient responsibility is $100. Please reduce the balance accordingly within 14 days.",
            },
          },
        ],
      },
    ]);
    await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    const sys = capturedSystem[0] ?? "";
    expect(sys).toContain("What we know about Aetna");
    expect(sys).toContain("Aetna often agrees to the EOB amount");
    expect(sys).toContain("(1 negotiation contributed to this playbook.)");
  });

  test("provider with no brain page → no playbook block in system prompt", async () => {
    const { state, client } = await makeStartedState("Brand New Provider Inc");
    await client.ingestInbound({
      from: "x@y.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We received your appeal.",
      thread_id: state.thread_id,
    });
    const { client: anth, capturedSystem } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_email",
            input: {
              subject: "Re: Re: Appeal",
              body_text:
                "Following up on our initial dispute. Please review the EOB-referenced charges and reduce within 14 days.",
            },
          },
        ],
      },
    ]);
    await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    const sys = capturedSystem[0] ?? "";
    expect(sys).not.toContain("What we know about");
    expect(sys).not.toContain("contributed to this playbook");
    // Sanity: the rest of the prompt is intact.
    expect(sys).toContain("You are Bonsai");
  });
});

/**
 * Integration test for the propagate-to-brain wiring inside
 * stepNegotiation.
 *
 * Proves: when a step closes a thread (mark_resolved or
 * escalate_human), the propagate-to-brain skill is invoked with the
 * full thread + final outcome, and a successful result writes a
 * brain page that subsequent reads can pick up.
 *
 * Hermetic — mocks the negotiation Claude AND the propagate-to-brain
 * Claude call via injected runners. No network.
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
import { readBrain, readRecentEvents } from "../src/brain/provider-brain.ts";
import type { AnalyzerResult } from "../src/types.ts";
import type { LLMRequest, LLMResponse } from "../src/llm/provider.ts";

const TEST_DB_DIR = join(tmpdir(), `bonsai-brain-int-${process.pid}-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, "bonsai.db");

function nukeDb(): void {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  _resetDbForTest();
}

function fixtureAnalyzer(): AnalyzerResult {
  return {
    metadata: {
      patient_name: "Test Patient",
      provider_name: "Aetna",
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

function mockAnthropicSdk(scriptedResponses: MockResponse[]): Anthropic {
  const queue = [...scriptedResponses];
  return {
    messages: {
      create: async () => {
        const next = queue.shift();
        if (!next) throw new Error("Mock Anthropic SDK: no more scripted responses");
        return next;
      },
    },
  } as unknown as Anthropic;
}

let tmpDir: string;
let priorBrain: string | undefined;
let priorHmac: string | undefined;
let priorOptOut: string | undefined;

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB_PATH;
  nukeDb();
});

afterAll(() => {
  nukeDb();
  delete process.env.BONSAI_DB_PATH;
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bonsai-brain-int-"));
  nukeDb();
  priorBrain = process.env.BONSAI_BRAIN;
  priorHmac = process.env.BONSAI_BRAIN_HMAC_KEY;
  priorOptOut = process.env.BONSAI_BRAIN_OPT_OUT;
  process.env.BONSAI_BRAIN = "1";
  process.env.BONSAI_BRAIN_HMAC_KEY = "integration-test-hmac-secret-fortyplus-characters";
  delete process.env.BONSAI_BRAIN_OPT_OUT;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (priorBrain === undefined) delete process.env.BONSAI_BRAIN;
  else process.env.BONSAI_BRAIN = priorBrain;
  if (priorHmac === undefined) delete process.env.BONSAI_BRAIN_HMAC_KEY;
  else process.env.BONSAI_BRAIN_HMAC_KEY = priorHmac;
  if (priorOptOut === undefined) delete process.env.BONSAI_BRAIN_OPT_OUT;
  else process.env.BONSAI_BRAIN_OPT_OUT = priorOptOut;
});

async function makeStartedState(): Promise<{ state: NegotiationState; client: MockEmailClient }> {
  const client = new MockEmailClient(tmpDir);
  const { state } = await startNegotiation({
    analyzer: fixtureAnalyzer(),
    client,
    user_email: "patient@example.com",
    provider_email: "billing@aetna.example",
    final_acceptable_floor: 100,
  });
  return { state, client };
}

describe("stepNegotiation → propagate-to-brain", () => {
  test("on mark_resolved, propagates pattern events into the brain", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@aetna.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We agree to reduce the balance to the EOB amount.",
      thread_id: state.thread_id,
    });

    const anth = mockAnthropicSdk([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mark_resolved",
            input: {
              resolution: "full_adjustment",
              final_amount_owed: 100,
              notes: "Rep agreed to EOB amount in one round.",
            },
          },
        ],
      },
    ]);

    // Capture the propagate-to-brain LLM call (Claude). Returns a
    // valid pattern-level event + compiled_truth that passes the PII
    // gate.
    const propagateCalls: LLMRequest[] = [];
    const propagateRunner = async (req: LLMRequest): Promise<LLMResponse> => {
      propagateCalls.push(req);
      // Distinguish the propagate call from any other Anthropic call:
      // the propagate skill's force_tool is propagate_brain.
      if (req.force_tool !== "propagate_brain") {
        throw new Error(`unexpected anthropic call with force_tool=${req.force_tool}`);
      }
      return {
        text: "",
        tool_use: {
          name: "propagate_brain",
          input: {
            compiled_truth:
              "Aetna often agrees to the EOB amount on the first formal written dispute. Lead with the EOB citation and a deadline.",
            events: [
              {
                kind: "concession_unlock",
                detail: "Citing the EOB unlocked full adjustment in one round",
              },
              {
                kind: "outcome_pattern",
                detail: "Thread closed in a single round with full adjustment",
              },
            ],
          },
        },
      };
    };

    const next = await stepNegotiation({
      state,
      client,
      anthropic: anth,
      threadsDir: tmpDir,
      user_id: "user-test-1",
      runners: { anthropic: propagateRunner },
    });

    expect(next.outcome.status).toBe("resolved");
    expect(propagateCalls).toHaveLength(1);
    expect(propagateCalls[0]?.system).toContain("Aetna");
    expect(propagateCalls[0]?.system).toContain("RESOLVED");

    const page = readBrain("aetna");
    expect(page).not.toBeNull();
    expect(page?.display_name).toBe("Aetna");
    expect(page?.bill_kind).toBe("medical");
    expect(page?.compiled_truth).toContain("EOB");
    expect(page?.event_count).toBe(2);

    const events = readRecentEvents("aetna");
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["concession_unlock", "outcome_pattern"]),
    );
  });

  test("BONSAI_BRAIN unset → no propagation, no DB write", async () => {
    delete process.env.BONSAI_BRAIN;
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@aetna.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "Agreed.",
      thread_id: state.thread_id,
    });
    const anth = mockAnthropicSdk([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mark_resolved",
            input: {
              resolution: "full_adjustment",
              final_amount_owed: 100,
              notes: "Agreed.",
            },
          },
        ],
      },
    ]);
    let propagateCalls = 0;
    const propagateRunner = async (): Promise<LLMResponse> => {
      propagateCalls++;
      return { text: "" };
    };
    await stepNegotiation({
      state,
      client,
      anthropic: anth,
      threadsDir: tmpDir,
      user_id: "user-test-1",
      runners: { anthropic: propagateRunner },
    });
    expect(propagateCalls).toBe(0);
    expect(readBrain("aetna")).toBeNull();
  });

  test("user_id missing → propagation skipped (CLI-replay safe)", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@aetna.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "Agreed.",
      thread_id: state.thread_id,
    });
    const anth = mockAnthropicSdk([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mark_resolved",
            input: { resolution: "full_adjustment", final_amount_owed: 100, notes: "Agreed." },
          },
        ],
      },
    ]);
    let propagateCalls = 0;
    const propagateRunner = async (): Promise<LLMResponse> => {
      propagateCalls++;
      return { text: "" };
    };
    // No user_id passed — simulates a CLI replay or an entry point
    // that hasn't threaded the owner through yet.
    await stepNegotiation({
      state,
      client,
      anthropic: anth,
      threadsDir: tmpDir,
      runners: { anthropic: propagateRunner },
    });
    expect(propagateCalls).toBe(0);
    expect(readBrain("aetna")).toBeNull();
  });

  test("non-terminal step (send_email) → no propagation", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@aetna.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We received your appeal.",
      thread_id: state.thread_id,
    });
    const anth = mockAnthropicSdk([
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
                "Thank you for confirming receipt. The EOB clearly states patient responsibility. Please reduce accordingly within 14 days.",
            },
          },
        ],
      },
    ]);
    let propagateCalls = 0;
    const propagateRunner = async (): Promise<LLMResponse> => {
      propagateCalls++;
      return { text: "" };
    };
    const next = await stepNegotiation({
      state,
      client,
      anthropic: anth,
      threadsDir: tmpDir,
      user_id: "user-test-1",
      runners: { anthropic: propagateRunner },
    });
    expect(next.outcome.status).toBe("in_progress");
    expect(propagateCalls).toBe(0);
    expect(readBrain("aetna")).toBeNull();
  });
});

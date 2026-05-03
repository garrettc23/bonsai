/**
 * Tests for the co-pilot mode + signature-override + push-back budget
 * paths added in v0.1.36+. Pairs with test/negotiate-email.test.ts which
 * covers the autonomous-mode happy path.
 *
 * Each test injects a mocked Anthropic client (humanizer disabled via
 * BONSAI_DISABLE_HUMANIZER so we don't need a second mock for the tone
 * pass) and exercises one specific failure mode the eng review surfaced:
 *
 *   1. Co-pilot mode + agent calls mark_resolved → outcome is
 *      awaiting_user_review, NOT resolved.
 *   2. Push-back at MAX_PUSH_BACK_ROUNDS → next agent proposal
 *      force-escalates with reason "user_judgment_required" instead
 *      of looping a third time.
 *   3. requires_signature=true ALWAYS routes to awaiting_user_review,
 *      overriding autonomous mode.
 *   4. Webhook arriving while awaiting_user_review → step_negotiation
 *      no-ops (no LLM call), inbound is still appended to the thread.
 *
 * Run: bun test test/copilot-mode.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmailClient } from "../src/clients/email-mock.ts";
import {
  acceptProposedResolution,
  startNegotiation,
  stepNegotiation,
  stepNegotiationOnUserPushBack,
  MAX_PUSH_BACK_ROUNDS,
  type NegotiationState,
} from "../src/negotiate-email.ts";
import type { AnalyzerResult } from "../src/types.ts";

beforeAll(() => {
  // Skip the humanizer in every test so we don't need a second mock.
  // The tone-rewrite step is exercised in humanizer tests.
  process.env.BONSAI_DISABLE_HUMANIZER = "1";
});

function fixtureAnalyzer(): AnalyzerResult {
  return {
    metadata: {
      patient_name: "Test Patient",
      provider_name: "Test Hospital",
      provider_billing_address: "1 Main St",
      claim_number: "CLM-1",
      date_of_service: "2026-03-01",
      insurer_name: "Acme",
      eob_patient_responsibility: 100,
      bill_current_balance_due: 1000,
      account_number: "A1",
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
      headline: "$900 in errors.",
    },
    grounding_failures: [],
    meta: { model: "claude-opus-4-7", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
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
  callCount: () => number;
  capturedSystem: string[];
} {
  const queue = [...scriptedResponses];
  const captured: string[] = [];
  let calls = 0;
  const client = {
    messages: {
      create: async (req: { system: string }) => {
        calls += 1;
        captured.push(req.system);
        const next = queue.shift();
        if (!next) throw new Error("Mock Anthropic: queue empty");
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, callCount: () => calls, capturedSystem: captured };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bonsai-copilot-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function startedState(opts: {
  agent_mode?: "autonomous" | "copilot";
}): Promise<{ state: NegotiationState; client: MockEmailClient }> {
  const client = new MockEmailClient(tmpDir);
  const { state } = await startNegotiation({
    analyzer: fixtureAnalyzer(),
    client,
    user_email: "patient@example.com",
    provider_email: "billing@hospital.example",
    final_acceptable_floor: 100,
    agent_mode: opts.agent_mode,
  });
  return { state, client };
}

describe("co-pilot mode handler branching", () => {
  test("co-pilot + mark_resolved → awaiting_user_review (not resolved)", async () => {
    const { state, client } = await startedState({ agent_mode: "copilot" });
    expect(state.agent_mode).toBe("copilot");
    expect(state.push_back_count).toBe(0);
    expect(state.seq).toBe(0);

    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "Approved. Adjusted to $100.",
      thread_id: state.thread_id,
    });

    const { client: anth } = mockAnthropic([
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
              notes: "Provider conceded to EOB responsibility.",
            },
          },
        ],
      },
    ]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(next.outcome.status).toBe("awaiting_user_review");
    if (next.outcome.status === "awaiting_user_review") {
      expect(next.outcome.proposed_amount).toBe(100);
      expect(next.outcome.summary).toContain("EOB");
      expect(next.outcome.push_back_count).toBe(0);
    }
    expect(next.seq).toBe(1);
  });

  test("autonomous + mark_resolved → resolved (preserves prior behavior)", async () => {
    const { state, client } = await startedState({ agent_mode: "autonomous" });
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "Approved. Adjusted to $100.",
      thread_id: state.thread_id,
    });
    const { client: anth } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mark_resolved",
            input: { resolution: "full_adjustment", final_amount_owed: 100, notes: "ok" },
          },
        ],
      },
    ]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(next.outcome.status).toBe("resolved");
  });

  test("autonomous + requires_signature=true → awaiting_user_review override", async () => {
    const { state, client } = await startedState({ agent_mode: "autonomous" });
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "Sign the attached release; balance will be adjusted to $100.",
      thread_id: state.thread_id,
    });
    const { client: anth } = mockAnthropic([
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
              notes: "Rep agreed pending signed release.",
              requires_signature: true,
              signature_doc_summary: "release of all future claims related to this hospital stay",
            },
          },
        ],
      },
    ]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    // Even though mode is autonomous, requires_signature wins.
    expect(next.outcome.status).toBe("awaiting_user_review");
    if (next.outcome.status === "awaiting_user_review") {
      expect(next.outcome.requires_signature).toBe(true);
      expect(next.outcome.signature_doc_summary).toMatch(/release/);
    }
  });
});

describe("push-back budget force-escalation", () => {
  test(`mark_resolved at push_back_count=${MAX_PUSH_BACK_ROUNDS} force-escalates to user_judgment_required`, async () => {
    const { state, client } = await startedState({ agent_mode: "copilot" });
    // Synthesize the budget-exhausted state directly — push_back_count
    // already at MAX. The agent's next mark_resolved should hit the
    // resolveOrGate force-escalate path.
    const exhausted: NegotiationState = {
      ...state,
      push_back_count: MAX_PUSH_BACK_ROUNDS,
    };
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We can do $200 — final offer.",
      thread_id: state.thread_id,
    });
    const { client: anth } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mark_resolved",
            input: { resolution: "reduced", final_amount_owed: 200, notes: "Rep offered $200." },
          },
        ],
      },
    ]);
    const next = await stepNegotiation({ state: exhausted, client, anthropic: anth, threadsDir: tmpDir });
    expect(next.outcome.status).toBe("escalated");
    if (next.outcome.status === "escalated") {
      expect(next.outcome.reason).toBe("user_judgment_required");
      expect(next.outcome.notes).toMatch(/exhausted|push-back|push.back/i);
    }
  });

  test("stepNegotiationOnUserPushBack with budget exhausted → no LLM call, force-escalates", async () => {
    const { state, client } = await startedState({ agent_mode: "copilot" });
    // Move state to awaiting_user_review at the budget cap — this is the
    // shape the endpoint sees when a user clicks Push Back after using
    // both rounds.
    const awaiting: NegotiationState = {
      ...state,
      outcome: {
        status: "awaiting_user_review",
        resolution: "reduced",
        proposed_amount: 200,
        summary: "Rep offered $200.",
        push_back_count: MAX_PUSH_BACK_ROUNDS,
      },
      push_back_count: MAX_PUSH_BACK_ROUNDS,
    };
    const { client: anth, callCount } = mockAnthropic([]);
    const next = await stepNegotiationOnUserPushBack({
      state: awaiting,
      client,
      note: "ask for $50",
      anthropic: anth,
      threadsDir: tmpDir,
    });
    expect(callCount()).toBe(0); // NO LLM call burned
    expect(next.outcome.status).toBe("escalated");
    if (next.outcome.status === "escalated") {
      expect(next.outcome.reason).toBe("user_judgment_required");
    }
    expect(next.push_back_count).toBe(MAX_PUSH_BACK_ROUNDS + 1);
  });
});

describe("acceptProposedResolution", () => {
  test("awaiting_user_review → resolved", () => {
    const baseState: NegotiationState = {
      thread_id: "t",
      analyzer: fixtureAnalyzer(),
      user_email: "u@x.com",
      provider_email: "p@x.com",
      final_acceptable_floor: 100,
      last_seen_inbound_ts: new Date(0).toISOString(),
      outcome: {
        status: "awaiting_user_review",
        resolution: "reduced",
        proposed_amount: 250,
        summary: "Rep agreed to $250.",
        push_back_count: 1,
      },
      agent_mode: "copilot",
      seq: 7,
    };
    const accepted = acceptProposedResolution(baseState);
    expect(accepted.outcome.status).toBe("resolved");
    if (accepted.outcome.status === "resolved") {
      expect(accepted.outcome.final_amount_owed).toBe(250);
      expect(accepted.outcome.notes).toBe("Rep agreed to $250.");
    }
    expect(accepted.seq).toBe(8);
  });

  test("idempotent on already-resolved", () => {
    const resolved: NegotiationState = {
      thread_id: "t",
      analyzer: fixtureAnalyzer(),
      user_email: "u@x.com",
      provider_email: "p@x.com",
      final_acceptable_floor: 100,
      last_seen_inbound_ts: new Date(0).toISOString(),
      outcome: {
        status: "resolved",
        resolution: "reduced",
        final_amount_owed: 250,
        notes: "done",
      },
      seq: 5,
    };
    const result = acceptProposedResolution(resolved);
    expect(result).toBe(resolved); // Reference equality — pass-through
  });
});

describe("inbound during awaiting_user_review", () => {
  test("stepNegotiation early-returns when not in_progress (preserves existing behavior)", async () => {
    const { state, client } = await startedState({ agent_mode: "copilot" });
    const awaiting: NegotiationState = {
      ...state,
      outcome: {
        status: "awaiting_user_review",
        resolution: "reduced",
        proposed_amount: 250,
        summary: "Rep agreed to $250.",
        push_back_count: 0,
      },
    };
    // Rep replies again while user hasn't acted.
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "Following up — please confirm.",
      thread_id: state.thread_id,
    });
    const { client: anth, callCount } = mockAnthropic([]);
    const next = await stepNegotiation({ state: awaiting, client, anthropic: anth, threadsDir: tmpDir });
    // No LLM call — agent doesn't auto-resume on inbound while user
    // review is pending.
    expect(callCount()).toBe(0);
    expect(next).toBe(awaiting);
    // The inbound IS persisted to the thread file (ingestInbound did
    // that) — when the user finally acts, the next agent turn will see it.
    const { loadThread } = await import("../src/clients/email-mock.ts");
    const thread = loadThread(state.thread_id, tmpDir);
    expect(thread.inbound.length).toBe(1);
  });
});

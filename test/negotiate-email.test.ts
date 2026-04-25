/**
 * Tests for the email negotiation agent loop.
 *
 * The agent at src/negotiate-email.ts is the central feature: $-figures the
 * UI displays land through it. We mock the Anthropic client (via the
 * `opts.anthropic` injection point) so the tests are deterministic and
 * cheap, then exercise:
 *
 *   - tool dispatch for send_email / mark_resolved / escalate_human
 *   - idempotency (last_seen_inbound_ts advancement)
 *   - MAX_TURNS exhaustion → forced escalation (NOT silent stall)
 *   - system prompt composition (tone, user_directives)
 *   - early return when the negotiation is already terminated
 *   - early return when no inbound messages have arrived
 *
 * Run: bun test test/negotiate-email.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmailClient } from "../src/clients/email-mock.ts";
import {
  startNegotiation,
  stepNegotiation,
  type NegotiationState,
} from "../src/negotiate-email.ts";
import type { AnalyzerResult } from "../src/types.ts";

function fixtureAnalyzer(): AnalyzerResult {
  return {
    metadata: {
      patient_name: "Test Patient",
      provider_name: "Test Hospital",
      provider_billing_address: "123 Main St, Springfield, IL 62701",
      claim_number: "CLM-001",
      date_of_service: "2026-03-01",
      insurer_name: "Acme Insurance",
      eob_patient_responsibility: 100,
      bill_current_balance_due: 1000,
      account_number: "ACCT-1",
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
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
  >;
}

function mockAnthropic(scriptedResponses: MockResponse[]): {
  client: Anthropic;
  capturedSystem: string[];
  callCount: () => number;
} {
  const queue = [...scriptedResponses];
  const capturedSystem: string[] = [];
  let calls = 0;
  const client = {
    messages: {
      create: async (req: { system: string }) => {
        calls += 1;
        capturedSystem.push(req.system);
        const next = queue.shift();
        if (!next) throw new Error("Mock Anthropic: no more scripted responses");
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, capturedSystem, callCount: () => calls };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bonsai-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeStartedState(opts?: {
  user_directives?: string;
  agent_tone?: NegotiationState["agent_tone"];
  floor?: number;
}): Promise<{ state: NegotiationState; client: MockEmailClient }> {
  const client = new MockEmailClient(tmpDir);
  const { state } = await startNegotiation({
    analyzer: fixtureAnalyzer(),
    client,
    user_email: "patient@example.com",
    provider_email: "billing@hospital.example",
    final_acceptable_floor: opts?.floor ?? 100,
    user_directives: opts?.user_directives,
    agent_tone: opts?.agent_tone,
  });
  return { state, client };
}

describe("startNegotiation", () => {
  test("sends the appeal letter and returns in_progress state", async () => {
    const { state, client } = await makeStartedState();
    expect(state.outcome.status).toBe("in_progress");
    expect(state.thread_id).toMatch(/^thread_/);
    expect(state.final_acceptable_floor).toBe(100);
    const inbound = await client.fetchInbound(state.thread_id, "");
    expect(inbound.length).toBe(0);
  });

  test("defaults floor to eob_patient_responsibility when not given", async () => {
    const client = new MockEmailClient(tmpDir);
    const { state } = await startNegotiation({
      analyzer: fixtureAnalyzer(),
      client,
      user_email: "p@x.com",
      provider_email: "b@x.com",
    });
    expect(state.final_acceptable_floor).toBe(100);
  });
});

describe("stepNegotiation — early returns", () => {
  test("no inbound → returns same state, no Anthropic call", async () => {
    const { state, client } = await makeStartedState();
    const { client: anth, callCount } = mockAnthropic([]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(next).toBe(state);
    expect(callCount()).toBe(0);
  });

  test("already-terminated state → returns same state", async () => {
    const { state, client } = await makeStartedState();
    const terminated: NegotiationState = {
      ...state,
      outcome: { status: "escalated", reason: "deadlock", notes: "test" },
    };
    const { client: anth, callCount } = mockAnthropic([]);
    const next = await stepNegotiation({ state: terminated, client, anthropic: anth, threadsDir: tmpDir });
    expect(next).toBe(terminated);
    expect(callCount()).toBe(0);
  });
});

describe("stepNegotiation — tool dispatch", () => {
  test("send_email tool → outbound persisted, state stays in_progress", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We received your appeal. We will review.",
      thread_id: state.thread_id,
    });
    const { client: anth } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_email",
            input: {
              subject: "Re: Re: Appeal",
              body_markdown:
                "Thank you for confirming receipt. Per our initial appeal dated last week, the EOB clearly states patient responsibility of $100. Please reduce the balance accordingly. We expect a response within 14 days.",
            },
          },
        ],
      },
    ]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(next.outcome.status).toBe("in_progress");
    expect(next.last_seen_inbound_ts).not.toBe(state.last_seen_inbound_ts);
    const allOutbound = (
      await Promise.all([client.fetchInbound(state.thread_id, "")])
    );
    void allOutbound;
    // The MockEmailClient persists outbound to the thread file; loadThread
    // is not exported on the client, but the appeal letter was sent in
    // startNegotiation and a follow-up was sent in this step → thread
    // should now have 2 outbound messages.
    const { loadThread } = await import("../src/clients/email-mock.ts");
    const t = loadThread(state.thread_id, tmpDir);
    expect(t.outbound.length).toBe(2);
    expect(t.outbound[1].subject).toBe("Re: Re: Appeal");
  });

  test("mark_resolved → outcome becomes resolved with the right fields", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "Approved. Balance adjusted to $100.",
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
              notes: "Provider agreed to adjust to EOB responsibility.",
            },
          },
        ],
      },
    ]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(next.outcome.status).toBe("resolved");
    if (next.outcome.status === "resolved") {
      expect(next.outcome.resolution).toBe("full_adjustment");
      expect(next.outcome.final_amount_owed).toBe(100);
    }
  });

  test("escalate_human → outcome becomes escalated with the right reason", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "If you keep contacting us we will involve our attorneys.",
      thread_id: state.thread_id,
    });
    const { client: anth } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "escalate_human",
            input: {
              reason: "legal",
              notes: "Provider mentioned attorneys; pulling out.",
            },
          },
        ],
      },
    ]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(next.outcome.status).toBe("escalated");
    if (next.outcome.status === "escalated") {
      expect(next.outcome.reason).toBe("legal");
    }
  });
});

describe("stepNegotiation — idempotency advance", () => {
  test("last_seen_inbound_ts advances to the newest inbound timestamp", async () => {
    const { state, client } = await makeStartedState();
    const m1 = await client.ingestInbound({
      from: "x@y",
      to: "p@x",
      subject: "Re: Appeal",
      body_text: "first",
      thread_id: state.thread_id,
    });
    // Force a small delay so the second message has a later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await client.ingestInbound({
      from: "x@y",
      to: "p@x",
      subject: "Re: Appeal",
      body_text: "second",
      thread_id: state.thread_id,
    });
    expect(Date.parse(m2.received_at)).toBeGreaterThanOrEqual(
      Date.parse(m1.received_at),
    );
    const { client: anth } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_email",
            input: {
              subject: "Re: Re: Appeal",
              body_markdown:
                "Thanks for the update. Per the EOB, please confirm balance has been adjusted to the patient responsibility of $100. Awaiting written confirmation within 14 days.",
            },
          },
        ],
      },
    ]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(next.last_seen_inbound_ts).toBe(m2.received_at);
  });
});

describe("stepNegotiation — MAX_TURNS exhaustion", () => {
  test("escalates with reason=unclear instead of silently stalling", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "x@y",
      to: "p@x",
      subject: "Re: Appeal",
      body_text: "ambiguous reply",
      thread_id: state.thread_id,
    });
    // Script 4 responses that all do tool_use but with an unknown tool, so
    // the inner loop never sets terminated=true.
    const stuckResponse: MockResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "t-stuck",
          name: "wander_off",
          input: {},
        },
      ],
    };
    const { client: anth, callCount } = mockAnthropic([
      stuckResponse,
      stuckResponse,
      stuckResponse,
      stuckResponse,
    ]);
    const next = await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(callCount()).toBe(4);
    expect(next.outcome.status).toBe("escalated");
    if (next.outcome.status === "escalated") {
      expect(next.outcome.reason).toBe("unclear");
      expect(next.outcome.notes).toMatch(/terminal tool/);
    }
  });
});

describe("cc threading — user stays in the loop", () => {
  test("initial appeal carries cc onto the SentEmail", async () => {
    const client = new MockEmailClient(tmpDir);
    const { state } = await startNegotiation({
      analyzer: fixtureAnalyzer(),
      client,
      user_email: "garrett@example.com",
      provider_email: "billing@hospital.example",
      final_acceptable_floor: 100,
      cc: ["garrett@example.com"],
    });
    const { loadThread } = await import("../src/clients/email-mock.ts");
    const t = loadThread(state.thread_id, tmpDir);
    expect(t.outbound.length).toBe(1);
    expect(t.outbound[0].cc).toEqual(["garrett@example.com"]);
  });

  test("follow-up sent during stepNegotiation also carries cc", async () => {
    const client = new MockEmailClient(tmpDir);
    const { state } = await startNegotiation({
      analyzer: fixtureAnalyzer(),
      client,
      user_email: "garrett@example.com",
      provider_email: "billing@hospital.example",
      final_acceptable_floor: 100,
      cc: ["garrett@example.com"],
    });
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We'll review and get back to you.",
      thread_id: state.thread_id,
    });
    const { client: anth } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_email",
            input: {
              subject: "Re: Re: Appeal",
              body_markdown:
                "Per our prior appeal, EOB patient responsibility is $100. We expect a written response within 14 days confirming the balance has been adjusted accordingly to comply with the No Surprises Act.",
            },
          },
        ],
      },
    ]);
    await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    const { loadThread } = await import("../src/clients/email-mock.ts");
    const t = loadThread(state.thread_id, tmpDir);
    expect(t.outbound.length).toBe(2);
    expect(t.outbound[0].cc).toEqual(["garrett@example.com"]);
    expect(t.outbound[1].cc).toEqual(["garrett@example.com"]);
  });
});

describe("stepNegotiation — system prompt composition", () => {
  test("agent_tone injects the tone heading + guidance", async () => {
    const { state, client } = await makeStartedState({ agent_tone: "aggressive" });
    await client.ingestInbound({
      from: "x@y",
      to: "p@x",
      subject: "Re: Appeal",
      body_text: "We deny.",
      thread_id: state.thread_id,
    });
    const { client: anth, capturedSystem } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "escalate_human",
            input: { reason: "deadlock", notes: "test" },
          },
        ],
      },
    ]);
    await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(capturedSystem[0]).toContain("User-specified tone: aggressive");
  });

  test("user_directives are appended verbatim after the marker heading", async () => {
    const { state, client } = await makeStartedState({
      user_directives: "Do not mention hardship. Reference NSA only.",
    });
    await client.ingestInbound({
      from: "x@y",
      to: "p@x",
      subject: "Re: Appeal",
      body_text: "We deny.",
      thread_id: state.thread_id,
    });
    const { client: anth, capturedSystem } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "escalate_human",
            input: { reason: "deadlock", notes: "test" },
          },
        ],
      },
    ]);
    await stepNegotiation({ state, client, anthropic: anth, threadsDir: tmpDir });
    expect(capturedSystem[0]).toContain("User directives");
    expect(capturedSystem[0]).toContain("Do not mention hardship");
  });
});

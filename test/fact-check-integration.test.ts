/**
 * Integration test for the cross-modal fact-check inside stepNegotiation.
 *
 * Proves the retry-once loop: when the OpenAI fact-check reports
 * violations, the loop feeds them back as a tool_result error and
 * Claude redrafts. The corrected draft passes and is the one that
 * reaches the email client.
 *
 * Hermetic — uses the mock Anthropic client (existing pattern) for the
 * negotiation agent and an injected runner for the fact-check OpenAI
 * call. No real API calls.
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
import type { LLMRequest, LLMResponse } from "../src/llm/provider.ts";

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
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
}

function mockAnthropic(scriptedResponses: MockResponse[]): {
  client: Anthropic;
  callCount: () => number;
} {
  const queue = [...scriptedResponses];
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        const next = queue.shift();
        if (!next) throw new Error("Mock Anthropic: no more scripted responses");
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, callCount: () => calls };
}

let tmpDir: string;
let priorCrossModal: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bonsai-test-fc-"));
  priorCrossModal = process.env.BONSAI_CROSSMODAL;
  process.env.BONSAI_CROSSMODAL = "1";
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (priorCrossModal === undefined) delete process.env.BONSAI_CROSSMODAL;
  else process.env.BONSAI_CROSSMODAL = priorCrossModal;
});

async function makeStartedState(): Promise<{ state: NegotiationState; client: MockEmailClient }> {
  const client = new MockEmailClient(tmpDir);
  const { state } = await startNegotiation({
    analyzer: fixtureAnalyzer(),
    client,
    user_email: "patient@example.com",
    provider_email: "billing@hospital.example",
    final_acceptable_floor: 100,
  });
  return { state, client };
}

describe("stepNegotiation — cross-modal fact-check loop", () => {
  test("violations on first draft → agent redrafts; only the clean draft is sent", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We received your appeal. Please clarify.",
      thread_id: state.thread_id,
    });

    // Anthropic mock: turn 1 sends a draft with a fabricated claim
    // number (CLM-999); turn 2 sends a clean redraft.
    const { client: anth, callCount: anthCalls } = mockAnthropic([
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
                "Per claim CLM-999 the EOB shows patient responsibility of $100. Please reduce the balance from $1000 accordingly. We expect a response within 14 days.",
            },
          },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "send_email",
            input: {
              subject: "Re: Re: Appeal",
              body_text:
                "Per claim CLM-001 the EOB shows patient responsibility of $100. Please reduce the balance from $1000 accordingly. We expect a response within 14 days.",
            },
          },
        ],
      },
    ]);

    // OpenAI runner: dispatches by force_tool so classify-reply,
    // fact-check, and adversarial-review each get the right shape
    // back. First fact-check call flags the fabrication; second
    // passes. Capture all calls so we can assert on what reached the
    // fact-check runner specifically.
    const factCheckCalls: LLMRequest[] = [];
    let fcInvocations = 0;
    const openaiStub = async (req: LLMRequest): Promise<LLMResponse> => {
      if (req.force_tool === "classify_reply") {
        return {
          text: "",
          tool_use: {
            name: "classify_reply",
            input: { kind: "stall", confidence: "medium", reasoning: "rep is reviewing" },
          },
        };
      }
      if (req.force_tool === "adversarial_report") {
        return {
          text: "",
          tool_use: { name: "adversarial_report", input: { passed: true, weak_points: [] } },
        };
      }
      // Default: fact-check.
      factCheckCalls.push(req);
      fcInvocations++;
      if (fcInvocations === 1) {
        return {
          text: "",
          tool_use: {
            name: "fact_check_report",
            input: {
              passed: false,
              violations: [
                {
                  kind: "fabricated",
                  detail:
                    "Draft references claim CLM-999 but the analyzer's claim number is CLM-001.",
                },
              ],
            },
          },
        };
      }
      return {
        text: "",
        tool_use: { name: "fact_check_report", input: { passed: true, violations: [] } },
      };
    };

    const next = await stepNegotiation({
      state,
      client,
      anthropic: anth,
      threadsDir: tmpDir,
      runners: { openai: openaiStub },
    });

    // Negotiation outcome: in_progress (single send, awaiting reply).
    expect(next.outcome.status).toBe("in_progress");
    // Two Anthropic turns: one bad draft, one clean redraft.
    expect(anthCalls()).toBe(2);
    // Two fact-check calls: one fail, one pass.
    expect(fcInvocations).toBe(2);
    // The clean draft (CLM-001) reached the fact-check runner on the
    // second invocation; the first saw the fabricated CLM-999.
    expect(factCheckCalls[0]?.system).toContain("CLM-999");
    expect(factCheckCalls[1]?.system).toContain("CLM-001");
    expect(factCheckCalls[1]?.system).not.toContain("CLM-999");
    // Two outbounds: the deterministic appeal letter from
    // startNegotiation, then the negotiation reply (the clean redraft —
    // the bad draft never reached client.send). Humanizer is disabled
    // by test/setup.ts so the body passes through untouched.
    const thread = (await import("../src/clients/email-mock.ts")).loadThread(
      state.thread_id,
      tmpDir,
    );
    expect(thread.outbound).toHaveLength(2);
    const reply = thread.outbound[1];
    expect(reply?.body_text).toContain("CLM-001");
    expect(reply?.body_text).not.toContain("CLM-999");
  });

  test("BONSAI_CROSSMODAL off → fact-check is skipped, single send goes through", async () => {
    delete process.env.BONSAI_CROSSMODAL;
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We received your appeal.",
      thread_id: state.thread_id,
    });
    const { client: anth, callCount: anthCalls } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_email",
            input: {
              subject: "Re: Re: Appeal",
              body_text: "Even a draft with CLM-999 ships when crossmodal is off; this is the gate working.",
            },
          },
        ],
      },
    ]);
    let fcInvocations = 0;
    const openaiStub = async (): Promise<LLMResponse> => {
      fcInvocations++;
      return { text: "" };
    };
    await stepNegotiation({
      state,
      client,
      anthropic: anth,
      threadsDir: tmpDir,
      runners: { openai: openaiStub },
    });
    expect(anthCalls()).toBe(1);
    expect(fcInvocations).toBe(0);
  });

  test("retry budget exhausted → ships draft anyway with warning", async () => {
    const { state, client } = await makeStartedState();
    await client.ingestInbound({
      from: "billing@hospital.example",
      to: "patient@example.com",
      subject: "Re: Appeal",
      body_text: "We received your appeal.",
      thread_id: state.thread_id,
    });
    // Both Anthropic turns ship drafts the fact-check rejects. The
    // second send_email exhausts the budget and ships anyway.
    const { client: anth } = mockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_email",
            input: { subject: "Re: x", body_text: "Bad draft 1 with CLM-999 fabrication, well over fifty characters long." },
          },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "send_email",
            input: { subject: "Re: x", body_text: "Bad draft 2 still wrong with CLM-998 fabrication, well over fifty characters." },
          },
        ],
      },
    ]);
    const openaiStub = async (req: LLMRequest): Promise<LLMResponse> => {
      if (req.force_tool === "classify_reply") {
        return {
          text: "",
          tool_use: {
            name: "classify_reply",
            input: { kind: "stall", confidence: "medium", reasoning: "rep is reviewing" },
          },
        };
      }
      if (req.force_tool === "adversarial_report") {
        return {
          text: "",
          tool_use: { name: "adversarial_report", input: { passed: true, weak_points: [] } },
        };
      }
      // Default: fact-check fails on every call → exhausts budget.
      return {
        text: "",
        tool_use: {
          name: "fact_check_report",
          input: {
            passed: false,
            violations: [{ kind: "fabricated", detail: "Wrong claim number again." }],
          },
        },
      };
    };
    const next = await stepNegotiation({
      state,
      client,
      anthropic: anth,
      threadsDir: tmpDir,
      runners: { openai: openaiStub },
    });
    expect(next.outcome.status).toBe("in_progress");
    const thread = (await import("../src/clients/email-mock.ts")).loadThread(
      state.thread_id,
      tmpDir,
    );
    // Two outbounds: the appeal letter from startNegotiation, then the
    // second bad draft shipped after the retry budget was exhausted.
    // The first bad draft never reached client.send.
    expect(thread.outbound).toHaveLength(2);
    expect(thread.outbound[1]?.body_text).toContain("Bad draft 2");
    expect(thread.outbound[1]?.body_text).not.toContain("Bad draft 1");
  });
});

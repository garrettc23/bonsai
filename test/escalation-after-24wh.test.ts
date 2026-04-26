/**
 * Persistent-mode 24wh idle escalation contract.
 *
 * When an outbound email has been idle for 24+ working hours and the rep
 * hasn't replied, the advance pass dials voice. Idempotent — once the
 * escalation gate is set, advance does not redial.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveNegotiationState,
  loadNegotiationState,
  type NegotiationState,
} from "../src/negotiate-email.ts";
import { advancePersistentNegotiation } from "../src/server/persistent-advance.ts";
import type { AnalyzerResult, BillContact } from "../src/types.ts";
import type { BonsaiReport } from "../src/orchestrator.ts";
import type { User } from "../src/lib/auth.ts";

const TEST_DIR = join(tmpdir(), `bonsai-advance-${process.pid}-${Date.now()}`);

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeAnalyzer(): AnalyzerResult {
  return {
    metadata: {
      patient_name: "Alice", provider_name: "Provider", provider_billing_address: null,
      claim_number: null, date_of_service: null, insurer_name: null,
      eob_patient_responsibility: null, bill_current_balance_due: 1200, account_number: null,
    },
    errors: [],
    summary: { high_confidence_total: 0, worth_reviewing_total: 0, bill_total_disputed: 0, headline: "fake" },
    grounding_failures: [],
    meta: { model: "fake", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

function makeRun(threadId: string, contact: BillContact): {
  run_id: string;
  partial_report: BonsaiReport;
  contact: BillContact;
  status?: string;
} {
  const analyzer = makeAnalyzer();
  return {
    run_id: "run_test",
    contact,
    status: "negotiating",
    partial_report: {
      analyzer,
      appeal: { subject: "x", markdown: "x" },
      strategy: { chosen: "persistent", reason: "test" },
      summary: {
        original_balance: 1200,
        defensible_disputed: 0,
        final_balance: null,
        patient_saved: null,
        channel_used: "persistent",
        outcome: "in_progress",
        outcome_detail: "",
      },
      email_thread: { thread_id: threadId, state: {} as NegotiationState, messages: [] },
    },
  };
}

function fakeUser(): User {
  return { id: "test_user", email: "alice@example.com" } as User;
}

function seedState(threadsDir: string, threadId: string, overrides: Partial<NegotiationState>): NegotiationState {
  mkdirSync(threadsDir, { recursive: true });
  // The analyzer field is required by the type but we don't dial it.
  const state: NegotiationState = {
    thread_id: threadId,
    analyzer: makeAnalyzer(),
    user_email: "alice@example.com",
    provider_email: "billing@provider.com",
    final_acceptable_floor: 0,
    last_seen_inbound_ts: new Date(0).toISOString(),
    outcome: { status: "in_progress" },
    ...overrides,
  };
  saveNegotiationState(state, threadsDir);
  return state;
}

describe("advancePersistentNegotiation", () => {
  test("escalates to voice after 25 working hours of idle", async () => {
    const threadsDir = join(TEST_DIR, "threads-1");
    const threadId = "thread_1";
    // Pin to a known Mon-09:00 PT and outbound to the previous Mon-09:00
    // PT — 5 full business days of working hours = 40h, comfortably past
    // the 24wh threshold regardless of when the test happens to run.
    const fourDaysAgo = new Date("2026-04-20T16:00:00Z");
    const fixedNow = new Date("2026-04-27T16:00:00Z");
    seedState(threadsDir, threadId, {
      email_outbound_sent_at: fourDaysAgo.toISOString(),
      last_inbound_received_at: null,
    });
    const run = makeRun(threadId, {
      support_email: "billing@provider.com",
      support_phone: "+15551234567",
    });

    let dialedWith: { provider_phone: string } | null = null;
    const fakeDial: any = async (_user: User, opts: { provider_phone: string }) => {
      dialedWith = opts;
      return { ok: true, conversation_id: "conv_1", agent_id: "agent_1", agent_cached: false, dry_run: false };
    };

    const result = await advancePersistentNegotiation({
      user: fakeUser(),
      run,
      threadsDir,
      dial: fakeDial,
      now: fixedNow,
    });

    expect(result.action).toBe("escalated_voice");
    expect(dialedWith).not.toBeNull();
    expect(dialedWith!.provider_phone).toBe("+15551234567");

    // Idempotent — second call must not redial.
    dialedWith = null;
    const second = await advancePersistentNegotiation({
      user: fakeUser(),
      run,
      threadsDir,
      dial: fakeDial,
      now: fixedNow,
    });
    expect(second.action).toBe("noop");
    expect(dialedWith).toBeNull();
  });

  test("noop when rep replied since last outbound", async () => {
    const threadsDir = join(TEST_DIR, "threads-2");
    const threadId = "thread_2";
    const outboundAt = new Date("2026-04-20T16:00:00Z");
    const inboundAt = new Date("2026-04-23T16:00:00Z");
    const fixedNow = new Date("2026-04-27T16:00:00Z");
    seedState(threadsDir, threadId, {
      email_outbound_sent_at: outboundAt.toISOString(),
      last_inbound_received_at: inboundAt.toISOString(),
    });
    const run = makeRun(threadId, {
      support_email: "billing@provider.com",
      support_phone: "+15551234567",
    });

    let dialed = false;
    const result = await advancePersistentNegotiation({
      user: fakeUser(),
      run,
      threadsDir,
      dial: (async () => { dialed = true; return { ok: true } as any; }) as any,
      now: fixedNow,
    });

    expect(result.action).toBe("noop");
    expect(dialed).toBe(false);
  });

  test("noop when no provider phone on file", async () => {
    const threadsDir = join(TEST_DIR, "threads-3");
    const threadId = "thread_3";
    const outboundAt = new Date("2026-04-20T16:00:00Z");
    const fixedNow = new Date("2026-04-27T16:00:00Z");
    seedState(threadsDir, threadId, {
      email_outbound_sent_at: outboundAt.toISOString(),
    });
    const run = makeRun(threadId, { support_email: "billing@provider.com" });

    let dialed = false;
    const result = await advancePersistentNegotiation({
      user: fakeUser(),
      run,
      threadsDir,
      dial: (async () => { dialed = true; return { ok: true } as any; }) as any,
      now: fixedNow,
    });

    expect(result.action).toBe("noop");
    expect(dialed).toBe(false);
  });

  test("persists escalated_to_voice_at gate before dialing", async () => {
    const threadsDir = join(TEST_DIR, "threads-4");
    const threadId = "thread_4";
    const outboundAt = new Date("2026-04-20T16:00:00Z");
    const fixedNow = new Date("2026-04-27T16:00:00Z");
    seedState(threadsDir, threadId, {
      email_outbound_sent_at: outboundAt.toISOString(),
    });
    const run = makeRun(threadId, {
      support_email: "billing@provider.com",
      support_phone: "+15551234567",
    });

    await advancePersistentNegotiation({
      user: fakeUser(),
      run,
      threadsDir,
      dial: (async () => ({ ok: true }) as any) as any,
      now: fixedNow,
    });

    const after = loadNegotiationState(threadId, threadsDir);
    expect(after?.escalated_to_voice_at).toBeTruthy();
  });
});

/**
 * Replay mode — drive scripted inbound messages into a thread on a timer.
 *
 * Two callers:
 *   1. Demo fallback. If `DEMO_FALLBACK=1` is set and a real Resend inbound
 *      doesn't arrive within `watchdogMs` after an outbound, scripted replies
 *      land instead so the demo can't deadlock on flaky wifi.
 *   2. Cold-start "replaying live" rows. The receipts dashboard ships with
 *      seeded reports (see seed-receipts.ts); a future enhancement could
 *      replay those threads in real time so the demo opens in media res.
 *
 * The function is small on purpose: it appends an inbound and (if a
 * NegotiationState exists on disk) advances the agent one step. Concurrency
 * is serialized via the per-thread mutex from `lib/thread-store.ts`.
 */
import {
  appendInboundIdempotent,
  withThreadLock,
} from "./lib/thread-store.ts";
import {
  loadNegotiationState,
  saveNegotiationState,
  stepNegotiation,
} from "./negotiate-email.ts";
import { autoEmailClient } from "./clients/email-resend.ts";
import { newId } from "./clients/email.ts";
import type { InboundEmail } from "./clients/email.ts";

export interface ScriptedReply {
  /** ms after replay start when this reply should fire. */
  delay_ms: number;
  from: string;
  to: string;
  subject: string;
  body_text: string;
}

export interface ReplayOpts {
  thread_id: string;
  replies: ScriptedReply[];
  /** If true, skip the agent-step and only write the inbound. Useful for
   * pre-seeding a thread that already has a recorded outcome. */
  skipStep?: boolean;
}

export async function replayThreadInbound(opts: ReplayOpts): Promise<void> {
  for (const r of opts.replies) {
    if (r.delay_ms > 0) await sleep(r.delay_ms);
    await appendAndStep({
      thread_id: opts.thread_id,
      from: r.from,
      to: r.to,
      subject: r.subject,
      body_text: r.body_text,
      skipStep: opts.skipStep ?? false,
    });
  }
}

interface OneOpts {
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  body_text: string;
  skipStep: boolean;
}

async function appendAndStep(o: OneOpts): Promise<void> {
  const inbound: InboundEmail = {
    message_id: newId("replay"),
    received_at: new Date().toISOString(),
    from: o.from,
    to: o.to,
    subject: o.subject,
    body_text: o.body_text,
    thread_id: o.thread_id,
  };
  const { inserted } = await appendInboundIdempotent(o.thread_id, inbound);
  if (!inserted || o.skipStep) return;
  await withThreadLock(o.thread_id, async () => {
    const state = loadNegotiationState(o.thread_id);
    if (!state) return;
    if (state.outcome.status !== "in_progress") return;
    const client = await autoEmailClient();
    const next = await stepNegotiation({ state, client });
    saveNegotiationState(next);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

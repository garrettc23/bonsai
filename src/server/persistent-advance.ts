/**
 * Persistent-mode advance pass.
 *
 * When chooseChannel picks "persistent" (both email and phone on file), the
 * orchestrator dispatches the initial email and returns. Voice escalation
 * is not in-process — it's event-driven:
 *   - Resend webhook calls stepNegotiation on inbound replies (already wired
 *     in src/server/webhooks.ts).
 *   - This module runs on a periodic trigger (every /api/history GET, with a
 *     per-user 5-minute throttle) and dials voice when an outbound email
 *     has been idle for 24+ working hours.
 *
 * The 24-working-hour threshold is computed in the user's timezone via
 * src/lib/business-hours.ts so weekends and after-hours don't count.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { workingHoursElapsed } from "../lib/business-hours.ts";
import {
  loadNegotiationState,
  saveNegotiationState,
  type NegotiationState,
} from "../negotiate-email.ts";
import { dialVoiceForUser } from "./voice-dial.ts";
import { userPaths } from "../lib/user-paths.ts";
import type { User } from "../lib/auth.ts";
import type { BillContact, BillKind } from "../types.ts";
import type { BonsaiReport } from "../orchestrator.ts";
import { notifyUser } from "../lib/notify-user.ts";
import { withThreadLock } from "../lib/thread-store.ts";

const ESCALATION_THRESHOLD_HOURS = 24;
const ADVANCE_THROTTLE_MS = 5 * 60 * 1000;
/** A thread sitting in `awaiting_user_review` for this many days gets
 * force-escalated to `escalated` with reason "user_judgment_required".
 * The rep is silently waiting on the user's "we'll review" reply; if the
 * user doesn't act in a week, the thread is functionally dead and should
 * tell the user that explicitly. */
const STALE_AWAITING_USER_REVIEW_DAYS = 7;

const lastAdvanceByUser = new Map<string, number>();

interface AdvancePendingRun {
  run_id: string;
  partial_report: BonsaiReport;
  contact?: BillContact | null;
  resolved_contact?: { email: string | null; phone: string | null } | null;
  final_acceptable_floor?: number;
  status?: string;
}

/**
 * Idempotent advance for a single thread. Returns the action taken so
 * callers can log it or surface it in the audit trail.
 */
export async function advancePersistentNegotiation(opts: {
  user: User;
  run: AdvancePendingRun;
  threadsDir: string;
  /** Override for tests — defaults to dialVoiceForUser. */
  dial?: typeof dialVoiceForUser;
  /** Override for tests — defaults to current wall clock. */
  now?: Date;
  /** Working-hours timezone for idle math. */
  tz?: string;
}): Promise<{ action: "noop" | "escalated_voice"; reason: string; idleHours?: number }> {
  const { user, run, threadsDir } = opts;
  const dial = opts.dial ?? dialVoiceForUser;
  const now = opts.now ?? new Date();

  const threadId = run.partial_report?.email_thread?.thread_id;
  if (!threadId) return { action: "noop", reason: "no email thread on this run" };

  const state = loadNegotiationState(threadId, threadsDir);
  if (!state) return { action: "noop", reason: "no NegotiationState on disk" };
  if (state.outcome.status !== "in_progress") return { action: "noop", reason: "thread already terminal" };
  if (state.escalated_to_voice_at) return { action: "noop", reason: "already escalated to voice" };

  const outboundAt = state.email_outbound_sent_at;
  if (!outboundAt) return { action: "noop", reason: "no outbound timestamp recorded" };

  // If the rep replied since our last outbound, the email loop is the
  // active channel — let stepNegotiation handle it (the Resend webhook
  // already fires that path on inbound). We only escalate to voice when
  // they've gone silent on email.
  if (state.last_inbound_received_at && state.last_inbound_received_at > outboundAt) {
    return { action: "noop", reason: "rep replied since last outbound — email is active" };
  }

  const idleHours = workingHoursElapsed(new Date(outboundAt), now, opts.tz);
  if (idleHours < ESCALATION_THRESHOLD_HOURS) {
    return { action: "noop", reason: `idle ${idleHours.toFixed(1)}wh < threshold`, idleHours };
  }

  const providerPhone =
    run.contact?.support_phone?.trim() ||
    run.resolved_contact?.phone?.trim() ||
    null;
  if (!providerPhone) {
    return { action: "noop", reason: "no provider phone on file for voice escalation", idleHours };
  }

  const analyzer = run.partial_report?.analyzer;
  if (!analyzer) {
    return { action: "noop", reason: "run has no analyzer result", idleHours };
  }

  console.log(
    `[persistent ${run.run_id}] escalating to voice — no email reply in ${idleHours.toFixed(1)} working hours`,
  );

  // Persist the escalation gate BEFORE dialing so two concurrent advance
  // passes can't both fire a call. If the dial itself fails we keep the
  // gate set — operator can clear it manually after fixing config.
  const next: NegotiationState = {
    ...state,
    escalated_to_voice_at: now.toISOString(),
  };
  saveNegotiationState(next, threadsDir);

  const result = await dial(user, {
    run_id: run.run_id,
    analyzer,
    provider_phone: providerPhone,
    bill_kind: run.contact?.bill_kind as BillKind | undefined,
    account_holder_name: run.contact?.account_holder_name ?? null,
    final_acceptable_floor: run.final_acceptable_floor,
  });

  if (!result.ok) {
    console.warn(
      `[persistent ${run.run_id}] voice dial failed (${result.status}): ${result.error}`,
    );
  }

  return { action: "escalated_voice", reason: "24wh idle threshold crossed", idleHours };
}

/**
 * Periodic advance for every persistent-mode run belonging to the calling
 * user. Throttled to once per ADVANCE_THROTTLE_MS per user so SPA polls
 * don't fan out into repeated escalation work.
 *
 * Wired into the /api/history GET handler — that endpoint fires every few
 * seconds while the SPA is open, and threads only need a check every few
 * minutes for a 24wh threshold to be sufficient.
 */
export async function maybeAdvancePersistentForUser(user: User): Promise<void> {
  const lastAt = lastAdvanceByUser.get(user.id) ?? 0;
  const nowMs = Date.now();
  if (nowMs - lastAt < ADVANCE_THROTTLE_MS) return;
  lastAdvanceByUser.set(user.id, nowMs);

  const paths = userPaths(user.id);
  if (!existsSync(paths.pendingDir)) return;
  const threadsDir = paths.threadsDir;

  for (const file of readdirSync(paths.pendingDir)) {
    if (!file.endsWith(".json")) continue;
    let run: AdvancePendingRun;
    try {
      run = JSON.parse(readFileSync(join(paths.pendingDir, file), "utf-8")) as AdvancePendingRun;
    } catch {
      continue;
    }
    if (run.status !== "negotiating") continue;
    const strategy = run.partial_report?.strategy?.chosen;
    if (strategy !== "persistent") continue;

    try {
      await advancePersistentNegotiation({ user, run, threadsDir });
    } catch (err) {
      console.error(`[persistent ${run.run_id}] advance failed:`, err);
    }
  }

  // Independent sweep: find any `awaiting_user_review` threads older than
  // STALE_AWAITING_USER_REVIEW_DAYS and force-escalate them. Decoupled from
  // the pending-runs loop because awaiting_user_review threads aren't
  // necessarily in "negotiating" status — they're waiting on the user.
  try {
    await sweepStaleAwaitingUserReview(user.id);
  } catch (err) {
    console.error(`[stale-awaiting] sweep failed for user ${user.id}:`, err);
  }
}

/**
 * Walk the user's threads dir and force-escalate any `awaiting_user_review`
 * thread that's been sitting unreviewed for >7 days. Force-escalation
 * uses reason "user_judgment_required" so the UI can render "we waited a
 * week, you didn't reply, here's the offer — what do you want to do?"
 *
 * Idempotent: subsequent passes see the thread as `escalated` and skip.
 * Notifies the user once on transition (notify-user is itself durable +
 * email-best-effort).
 */
export async function sweepStaleAwaitingUserReview(user_id: string): Promise<void> {
  const paths = userPaths(user_id);
  const threadsDir = paths.threadsDir;
  if (!existsSync(threadsDir)) return;
  const cutoffMs = Date.now() - STALE_AWAITING_USER_REVIEW_DAYS * 24 * 60 * 60 * 1000;

  for (const file of readdirSync(threadsDir)) {
    if (!file.endsWith(".state.json")) continue;
    const fullPath = join(threadsDir, file);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    // mtime is the closest signal we have to "when did the agent transition
    // this to awaiting_user_review" — saveNegotiationState rewrites the
    // file on every state change, and awaiting_user_review is terminal
    // until the user acts. A migrate-on-read save will reset mtime, but
    // by then the state has agent_mode set so the sweep catches it on
    // the next periodic tick.
    if (stat.mtimeMs > cutoffMs) continue;

    const thread_id = file.slice(0, -".state.json".length);

    // Run the state mutation inside withThreadLock so the sweep can't
    // race with /accept, /push-back, or webhook stepNegotiation. Without
    // this, a user clicking Accept the same second the sweep runs could
    // have their resolution silently overwritten by a stale-escalation.
    // Re-read state INSIDE the lock — mtime check above is a fast filter,
    // not a synchronization barrier.
    const escalated = await withThreadLock(thread_id, async () => {
      const state = loadNegotiationState(thread_id, threadsDir);
      if (!state || state.outcome.status !== "awaiting_user_review") return null;

      const provider = state.analyzer.metadata.provider_name ?? "Unknown provider";
      const proposed_amount = state.outcome.proposed_amount;
      const summary = state.outcome.summary;

      const next: NegotiationState = {
        ...state,
        outcome: {
          status: "escalated",
          reason: "user_judgment_required",
          notes: `No user response in ${STALE_AWAITING_USER_REVIEW_DAYS} days. Latest agent proposal: ${summary} Proposed amount: $${proposed_amount.toFixed(2)}.`,
        },
        seq: (state.seq ?? 0) + 1,
      };
      saveNegotiationState(next, threadsDir);
      return { provider };
    });
    if (!escalated) continue;
    try {
      await notifyUser({
        user_id,
        thread_id,
        kind: "escalated",
        provider_name: escalated.provider,
        summary: `We waited ${STALE_AWAITING_USER_REVIEW_DAYS} days for your call on this offer. The thread is paused — open Bonsai to decide.`,
      });
    } catch (err) {
      console.warn(`[stale-awaiting] notify failed for ${thread_id}:`, (err as Error).message);
    }
  }
}

/** Test seam — clear the throttle so tests can run multiple advance passes. */
export function _resetPersistentAdvanceThrottle(): void {
  lastAdvanceByUser.clear();
}

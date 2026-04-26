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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const ESCALATION_THRESHOLD_HOURS = 24;
const ADVANCE_THROTTLE_MS = 5 * 60 * 1000;

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
}

/** Test seam — clear the throttle so tests can run multiple advance passes. */
export function _resetPersistentAdvanceThrottle(): void {
  lastAdvanceByUser.clear();
}

/**
 * Persistent Negotiation Agent.
 *
 * Runs the negotiation across both available channels until either:
 *   1. The rep concedes at or below the floor (EOB patient responsibility), OR
 *   2. Every channel has been tried and the best offer recorded.
 *
 * Ordering (cheapest first): email → voice.
 *
 * Each subsequent channel gets a "prior attempts" preface injected into its
 * analyzer context so Claude knows the dispute history and can anchor from the
 * prior rep's partial concessions ("your billing team already agreed to drop
 * line X on 2026-04-23 but refused to drop line Y — here's why Y is also
 * defensible under NSA..."). This matters because in real life the second
 * channel wouldn't start from scratch.
 *
 * This is the agent that matches the user ask: "shouldn't finish until it gets
 * the lowest price possible."
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AnalyzerResult } from "./types.ts";
import { MockEmailClient, loadThread } from "./clients/email-mock.ts";
import { autoEmailClient } from "./clients/email-resend.ts";
import {
  startNegotiation,
  stepNegotiation,
  saveNegotiationState,
  type NegotiationState,
} from "./negotiate-email.ts";
import { simulateReply, type Persona as EmailPersona } from "./simulate-reply.ts";
import { simulateCall, type RepPersona as VoicePersona } from "./voice/simulator.ts";
import type { CallState } from "./voice/tool-handlers.ts";
import type { AgentTone } from "./lib/user-settings.ts";

export type AttemptChannel = "email" | "voice";

export interface NegotiationAttempt {
  channel: AttemptChannel;
  final_amount: number | null; // null if escalated / no_adjustment
  saved: number | null;
  outcome: "resolved" | "escalated" | "in_progress" | "handed_off";
  outcome_detail: string;
  thread_id?: string; // email
  call_id?: string; // voice
  turns: number;
}

export interface PersistentNegotiationResult {
  floor: number;
  original_balance: number;
  attempts: NegotiationAttempt[];
  best: NegotiationAttempt | null;
  outcome:
    | "floor_hit"
    | "exhausted_with_offer"
    | "exhausted_no_offer"
    | "in_progress";
  total_saved: number;
  /** Human-facing one-line summary. */
  headline: string;
  /** Collected for UI rendering so the page can show both transcripts. */
  email?: {
    state: NegotiationState;
    messages: Array<{ role: "outbound" | "inbound"; subject: string; body: string; ts: string }>;
  };
  voice?: {
    state: CallState;
    transcript: Array<{ who: "agent" | "rep" | "tool"; text: string }>;
  };
}

export interface RunNegotiationAgentOpts {
  analyzer: AnalyzerResult;
  user_email?: string;
  provider_email?: string;
  user_phone?: string;
  provider_phone?: string;
  email_persona?: EmailPersona;
  voice_persona?: VoicePersona;
  final_acceptable_floor?: number;
  max_email_rounds?: number;
  /** If true, always run every channel even if floor is hit. For demos. Default false. */
  always_exhaust?: boolean;
  /** Which channels are allowed to run this round. Defaults to all enabled. */
  channels_enabled?: { email?: boolean; voice?: boolean };
  /** Free-form user directives piped into every negotiator's system prompt. */
  user_directives?: string;
  /** Tone override for every negotiator's system prompt. */
  agent_tone?: AgentTone;
  /** CC recipients on every outbound email — typically the user's own
   * inbox so they stay in the loop on every message the agent sends.
   * Visible to the rep on purpose. */
  cc?: string[];
  anthropic?: Anthropic;
}

/** Pretty-print prior attempts so the next channel's Claude has context. */
function formatPriorAttempts(attempts: NegotiationAttempt[]): string {
  if (attempts.length === 0) return "";
  const lines = attempts.map((a, i) => {
    const amt = a.final_amount != null ? `$${a.final_amount.toFixed(2)}` : "(no adjustment)";
    return `${i + 1}. ${a.channel.toUpperCase()} — ${a.outcome}, landed at ${amt}. ${a.outcome_detail}`;
  });
  return `\n\n## Prior negotiation attempts (context — do not repeat failed arguments verbatim)\n\n${lines.join("\n")}\n\nYou are escalating. Reference the prior channel's partial concession if any, and make the strongest remaining argument for the lines the prior rep refused to adjust.`;
}

/**
 * Drive one channel and pack the result into an attempt row.
 */
async function runEmailAttempt(opts: {
  analyzer: AnalyzerResult;
  user_email: string;
  provider_email: string;
  floor: number;
  persona: EmailPersona;
  max_rounds: number;
  original_balance: number;
  user_directives?: string;
  agent_tone?: AgentTone;
  prior_attempts_summary?: string;
  cc?: string[];
  anthropic: Anthropic;
}): Promise<{ attempt: NegotiationAttempt; view: PersistentNegotiationResult["email"] }> {
  // Pick Resend if env is configured, else fall back to MockEmailClient.
  // The two modes have very different orchestration: real Resend dispatches
  // one email and waits for the webhook to step the agent on actual rep
  // replies; mock mode runs a synthetic loop (Claude pretends to be the
  // rep) so the demo completes in seconds without external dependencies.
  const client = await autoEmailClient();
  const isReal = !(client instanceof MockEmailClient);
  const { thread_id, state: initState } = await startNegotiation({
    analyzer: opts.analyzer,
    client,
    user_email: opts.user_email,
    provider_email: opts.provider_email,
    final_acceptable_floor: opts.floor,
    user_directives: opts.user_directives,
    agent_tone: opts.agent_tone,
    prior_attempts_summary: opts.prior_attempts_summary,
    cc: opts.cc,
  });
  let state = initState;
  saveNegotiationState(state);
  let turns = isReal ? 1 : 0;
  if (!isReal) {
    // Demo mode: synthetic back-and-forth via the simulator. Closes out
    // resolved/escalated within a few seconds.
    for (let round = 1; round <= opts.max_rounds; round++) {
      const t = loadThread(thread_id);
      const latest = t.outbound[t.outbound.length - 1];
      await simulateReply({
        thread_id,
        turn_number: round,
        persona: opts.persona,
        analyzer: opts.analyzer,
        provider_email: opts.provider_email,
        user_email: opts.user_email,
        reply_to_subject: latest?.subject ?? "Appeal",
        latest_outbound_body: latest?.body_text ?? "",
        client: client as MockEmailClient,
        anthropic: opts.anthropic,
      });
      state = await stepNegotiation({ state, client, anthropic: opts.anthropic });
      saveNegotiationState(state);
      turns = round;
      if (state.outcome.status !== "in_progress") break;
    }
  }
  // In real mode, state.outcome.status is "in_progress" until the webhook
  // (src/server/webhooks.ts) catches a rep reply and calls stepNegotiation.
  const finalThread = loadThread(thread_id);
  const messages = [
    ...finalThread.outbound.map((m) => ({ role: "outbound" as const, subject: m.subject, body: m.body_text, ts: m.sent_at })),
    ...finalThread.inbound.map((m) => ({ role: "inbound" as const, subject: m.subject, body: m.body_text, ts: m.received_at })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  let final_amount: number | null = null;
  let outcome: NegotiationAttempt["outcome"] = "in_progress";
  let detail = `Email in progress after ${turns} rounds.`;
  if (state.outcome.status === "resolved") {
    final_amount = state.outcome.final_amount_owed;
    outcome = "resolved";
    detail = `Email ${state.outcome.resolution}. ${state.outcome.notes}`;
  } else if (state.outcome.status === "escalated") {
    outcome = "escalated";
    detail = `Email escalated (${state.outcome.reason}). ${state.outcome.notes}`;
  }
  const saved = final_amount != null ? opts.original_balance - final_amount : null;
  return {
    attempt: {
      channel: "email",
      final_amount,
      saved,
      outcome,
      outcome_detail: detail,
      thread_id,
      turns,
    },
    view: { state, messages },
  };
}

async function runVoiceAttempt(opts: {
  analyzer: AnalyzerResult;
  floor: number;
  persona: VoicePersona;
  original_balance: number;
}): Promise<{ attempt: NegotiationAttempt; view: PersistentNegotiationResult["voice"] }> {
  const { call_id, state, transcript } = await simulateCall({
    analyzer: opts.analyzer,
    persona: opts.persona,
    final_acceptable_floor: opts.floor,
    max_turns: 14,
  });
  let final_amount: number | null = state.outcome.negotiated_amount ?? null;
  let outcome: NegotiationAttempt["outcome"] = "in_progress";
  let detail = `Voice ended: ${state.outcome.status}.`;
  if (state.outcome.status === "success" || state.outcome.status === "partial") {
    outcome = "resolved";
    detail = `Voice ${state.outcome.status}. ${state.outcome.commitment_notes ?? ""}`;
  } else if (state.outcome.status === "handoff" || state.outcome.status === "voicemail_left") {
    outcome = "escalated";
    detail = `Voice ${state.outcome.status}${state.outcome.handoff_reason ? ` (${state.outcome.handoff_reason})` : ""}.`;
  } else if (state.outcome.status === "no_adjustment") {
    outcome = "escalated";
    detail = `Voice closed with no adjustment.`;
    final_amount = null;
  }
  const saved = final_amount != null ? opts.original_balance - final_amount : null;
  return {
    attempt: {
      channel: "voice",
      final_amount,
      saved,
      outcome,
      outcome_detail: detail,
      call_id,
      turns: transcript.length,
    },
    view: { state, transcript: transcript.map((t) => ({ who: t.who, text: t.text })) },
  };
}

/**
 * Main agent loop. Runs email → voice until the floor is hit or both
 * channels are exhausted. Picks the single best attempt and reports it.
 *
 * Prior-attempt context (`formatPriorAttempts`) is threaded into the voice
 * channel's analyzer context via `prior_attempts_summary` so the voice
 * agent doesn't repeat the email's failed arguments verbatim. Voice
 * currently uses the simulator path which doesn't accept the summary yet —
 * flagged as TODO; persona escalation continues to fill that gap.
 */
export async function runNegotiationAgent(
  opts: RunNegotiationAgentOpts,
): Promise<PersistentNegotiationResult> {
  const anthropic = opts.anthropic ?? new Anthropic();
  const floor =
    opts.final_acceptable_floor ?? opts.analyzer.metadata.eob_patient_responsibility ?? 0;
  const original_balance = opts.analyzer.metadata.bill_current_balance_due ?? 0;

  const user_email = opts.user_email ?? "patient@example.com";
  const provider_email = opts.provider_email ?? "billing@provider.example.com";

  const attempts: NegotiationAttempt[] = [];
  const result: PersistentNegotiationResult = {
    floor,
    original_balance,
    attempts,
    best: null,
    outcome: "exhausted_no_offer",
    total_saved: 0,
    headline: "",
  };

  // Small helper: is this attempt at or below the floor?
  const hitFloor = (a: NegotiationAttempt) => a.final_amount != null && a.final_amount <= floor + 0.01;

  // Pick the best among attempts that produced a number. Lower is better.
  const updateBest = () => {
    const withNum = attempts.filter((a) => a.final_amount != null);
    if (withNum.length === 0) {
      result.best = null;
      result.total_saved = 0;
      return;
    }
    let best = withNum[0];
    for (const a of withNum) if ((a.final_amount as number) < (best.final_amount as number)) best = a;
    result.best = best;
    result.total_saved = original_balance - (best.final_amount as number);
  };

  const channels = {
    email: opts.channels_enabled?.email !== false,
    voice: opts.channels_enabled?.voice !== false,
  };

  // 1. Email
  if (channels.email) {
    try {
      const { attempt, view } = await runEmailAttempt({
        analyzer: opts.analyzer,
        user_email,
        provider_email,
        floor,
        persona: opts.email_persona ?? "stall_then_concede",
        max_rounds: opts.max_email_rounds ?? 4,
        original_balance,
        user_directives: opts.user_directives,
        agent_tone: opts.agent_tone,
        cc: opts.cc,
        anthropic,
      });
      attempts.push(attempt);
      result.email = view;
      updateBest();
      if (hitFloor(attempt) && !opts.always_exhaust) {
        result.outcome = "floor_hit";
        result.headline = `Email hit the floor at $${attempt.final_amount?.toFixed(2)}. No further channels needed.`;
        return result;
      }
      // Real-email mode: dispatched one outbound and now waiting on the
      // webhook for replies. Don't proceed to the voice simulator — that
      // would mix a real-but-pending email negotiation with a synthetic
      // voice "resolved" outcome and the report would lie. Stop here;
      // the webhook will step the agent on real inbounds.
      if (attempt.outcome === "in_progress" && process.env.RESEND_API_KEY) {
        result.outcome = "in_progress";
        result.headline = `Email dispatched. Awaiting reply from ${provider_email}.`;
        return result;
      }
    } catch (err) {
      attempts.push({
        channel: "email",
        final_amount: null,
        saved: null,
        outcome: "escalated",
        outcome_detail: `Email attempt crashed: ${(err as Error).message}`,
        turns: 0,
      });
    }
  }

  // 2. Voice — last resort, highest conversion on tough disputes. Skipped
  // entirely in real-email mode because voice is still simulator-only;
  // pairing real email with fake voice was producing reports that claimed
  // a fake "Voice resolved at $X" outcome on top of a real-and-pending
  // email negotiation. Re-enable here once ElevenLabs is wired for real.
  const voiceSkippedForRealEmail = !!process.env.RESEND_API_KEY;
  if (channels.voice && !voiceSkippedForRealEmail) {
    void formatPriorAttempts(attempts); // reserved for the real ElevenLabs path
    try {
      const { attempt, view } = await runVoiceAttempt({
        analyzer: opts.analyzer,
        floor,
        persona: opts.voice_persona ?? "cooperative",
        original_balance,
      });
      attempts.push(attempt);
      result.voice = view;
      updateBest();
      if (hitFloor(attempt)) {
        result.outcome = "floor_hit";
        result.headline = `Voice hit the floor at $${attempt.final_amount?.toFixed(2)} after email stalled.`;
        return result;
      }
    } catch (err) {
      attempts.push({
        channel: "voice",
        final_amount: null,
        saved: null,
        outcome: "escalated",
        outcome_detail: `Voice attempt crashed: ${(err as Error).message}`,
        turns: 0,
      });
    }
  }

  const disabled = Object.entries(channels).filter(([, on]) => !on).map(([k]) => k);
  if (disabled.length > 0 && attempts.length === 0) {
    result.outcome = "exhausted_no_offer";
    result.headline = `No channels ran — user disabled ${disabled.join(", ")}.`;
    return result;
  }

  // Real-email mode and email errored before dispatch (Resend 403, etc.).
  // Voice was skipped intentionally; report email's failure clearly so the
  // operator can fix the underlying config (verify domain, check from
  // address, etc.) instead of seeing a misleading "exhausted" headline.
  if (voiceSkippedForRealEmail && attempts.length === 1 && attempts[0].channel === "email") {
    const a = attempts[0];
    if (a.outcome === "escalated") {
      result.outcome = "exhausted_no_offer";
      result.headline = `Email send failed before dispatch. ${a.outcome_detail}`;
      return result;
    }
  }

  // Exhausted both channels.
  if (result.best && result.best.final_amount != null) {
    result.outcome = "exhausted_with_offer";
    result.headline = `Both channels exhausted. Best offer: ${result.best.channel.toUpperCase()} at $${result.best.final_amount.toFixed(2)} (saved $${result.total_saved.toFixed(2)}). Floor of $${floor.toFixed(2)} not reached.`;
  } else {
    result.outcome = "exhausted_no_offer";
    result.headline = `Both channels exhausted, no concession secured. Recommend human escalation.`;
  }

  return result;
}

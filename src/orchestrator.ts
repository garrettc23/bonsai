/**
 * Bonsai orchestrator — single entry point for "analyze a bill end-to-end".
 *
 * Stages:
 *   1. Analyze bill + EOB (grounded, tool-using).
 *   2. Generate appeal letter (deterministic).
 *   3. Choose a channel (email | voice | both) and execute negotiation.
 *   4. Return a single report object the UI can render.
 *
 * Strategy heuristic:
 *   - balance_billing finding AND defensible_total >= $1,500 → "voice first"
 *     (phone converts better on high-signal disputes).
 *   - Otherwise → email (cheaper, async, lower friction).
 *   - User can always override via channel option.
 *
 * Every step is simulated end-to-end unless Resend/ElevenLabs env vars are
 * set. Swapping to real is a one-env-var flip.
 */
import { analyze } from "./analyzer.ts";
import { generateAppealLetter, type AppealLetter } from "./appeal-letter.ts";
import type { AnalyzerResult } from "./types.ts";
import { loadFixtureAnalyzeInput, type AnalyzeInput } from "./lib/fixture-audit.ts";
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
import { runNegotiationAgent, type PersistentNegotiationResult } from "./negotiate-agent.ts";

export type Channel = "email" | "voice" | "persistent" | "auto";

export interface RunBonsaiOpts {
  /**
   * File paths for the original bill / EOB. Optional — when omitted, the
   * fixture at `fixtures/<billFixtureName>.pdf` is used. These paths are
   * carried into the negotiation phase for potential future use but are
   * not opened directly by the negotiation code.
   */
  billPdfPath?: string;
  eobPdfPath?: string;
  /**
   * Identifier used for output filenames (out/report-<name>.json) and for
   * default fixture lookup when `analyzeInput` is not provided.
   */
  billFixtureName: string;
  /**
   * Pre-built analyzer input — normalized bill (+ optional EOB) and the
   * pre-loaded ground truth for line_quote validation. When set, the
   * analyzer runs against these instead of loading from fixtures.
   */
  analyzeInput?: AnalyzeInput;
  user_email?: string;
  provider_email?: string;
  user_phone?: string;
  provider_phone?: string;
  channel?: Channel;
  email_persona?: EmailPersona; // for simulation
  voice_persona?: VoicePersona; // for simulation
  final_acceptable_floor?: number;
  max_email_rounds?: number;
  /** Per-run channel gating. Overrides default email→voice order. */
  channels_enabled?: { email?: boolean; voice?: boolean };
  /** Free-form user directives piped into every negotiator's system prompt. */
  user_directives?: string;
  /** Tone the user asked the agent to strike. */
  agent_tone?: "polite" | "firm" | "aggressive";
  /** CC recipients on every outbound email — typically the user's own
   * inbox so they stay in the loop on every message the agent sends. */
  cc?: string[];
}

export interface ThreadMessage {
  role: "outbound" | "inbound";
  subject: string;
  body: string;
  ts: string;
}

export interface BonsaiReport {
  analyzer: AnalyzerResult;
  appeal: AppealLetter;
  strategy: {
    chosen: "email" | "voice" | "persistent";
    reason: string;
  };
  persistent_run?: PersistentNegotiationResult;
  email_thread?: {
    thread_id: string;
    state: NegotiationState;
    messages: ThreadMessage[];
  };
  voice_call?: {
    call_id: string;
    state: CallState;
    transcript: Array<{ who: "agent" | "rep" | "tool"; text: string }>;
  };
  summary: {
    original_balance: number;
    defensible_disputed: number;
    final_balance: number | null;
    patient_saved: number | null;
    channel_used: "email" | "voice" | "persistent";
    outcome: "resolved" | "escalated" | "in_progress";
    outcome_detail: string;
  };
}

export function chooseChannel(
  analyzer: AnalyzerResult,
  explicit: Channel,
): { chosen: "email" | "voice" | "persistent"; reason: string } {
  if (explicit === "email") return { chosen: "email", reason: "Caller explicitly requested email." };
  if (explicit === "voice") return { chosen: "voice", reason: "Caller explicitly requested voice." };
  if (explicit === "persistent")
    return {
      chosen: "persistent",
      reason: "Persistent mode: run email → voice until floor is hit or both channels exhausted.",
    };
  const hasBB = analyzer.errors.some((e) => e.confidence === "high" && e.error_type === "balance_billing");
  const total = analyzer.summary.high_confidence_total;
  if (hasBB && total >= 1500) {
    return {
      chosen: "voice",
      reason: `Balance-billing finding of $${total.toFixed(2)} — phone converts better than email on NSA disputes above $1,500.`,
    };
  }
  return { chosen: "email", reason: "No balance-billing envelope or dispute below $1,500 — email is the right first move." };
}

/**
 * Phase 1: Audit only. Read the bill + EOB, produce findings, the appeal letter,
 * and the channel strategy. Does NOT touch negotiation. Cheap + fast — the user
 * reviews the output, can ask follow-up questions, and explicitly approves the
 * plan before we reach out to the provider.
 */
export async function runAuditPhase(opts: RunBonsaiOpts): Promise<BonsaiReport> {
  const input =
    opts.analyzeInput ??
    (await loadFixtureAnalyzeInput(
      opts.billFixtureName,
      opts.billFixtureName.replace(/^bill-/, "eob-"),
    ));
  const analyzer = await analyze({
    bill: input.bill,
    eob: input.eob,
    billGroundTruth: input.billGroundTruth,
  });

  const appeal = generateAppealLetter(analyzer);
  const strategy = chooseChannel(analyzer, opts.channel ?? "auto");

  const originalBalance = analyzer.metadata.bill_current_balance_due ?? 0;
  const defensible = analyzer.summary.high_confidence_total;

  return {
    analyzer,
    appeal,
    strategy,
    summary: {
      original_balance: originalBalance,
      defensible_disputed: defensible,
      final_balance: null,
      patient_saved: null,
      channel_used: strategy.chosen,
      outcome: "in_progress",
      outcome_detail: "Awaiting user approval of the plan.",
    },
  };
}

/**
 * True when the provider email's domain is a reserved testing TLD —
 * .example / .test / .invalid / .localhost (RFC 2606 / 6761). These are
 * never deliverable through Resend; routing them through the simulator
 * keeps the sample-bill demo from immediately failing.
 */
function isSyntheticEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  const tld = domain.split(".").pop();
  return tld === "example" || tld === "test" || tld === "invalid" || tld === "localhost";
}

/**
 * Phase 2: Execute the negotiation against an already-audited bill. Takes the
 * partial report from `runAuditPhase` and fills in `persistent_run`, thread
 * transcripts, and final `summary.outcome`.
 */
export async function runNegotiationPhase(
  partial: BonsaiReport,
  opts: RunBonsaiOpts,
): Promise<BonsaiReport> {
  const report: BonsaiReport = structuredClone(partial);
  const analyzer = report.analyzer;
  const strategy = report.strategy;
  const originalBalance = report.summary.original_balance;

  const patientEmail = opts.user_email ?? "patient@example.com";
  const providerEmail = opts.provider_email ?? "billing@provider.example.com";
  const patientPhone = opts.user_phone ?? "+14155550100";
  const providerPhone = opts.provider_phone ?? "+14155550132";

  if (strategy.chosen === "persistent") {
    const run = await runNegotiationAgent({
      analyzer,
      user_email: patientEmail,
      provider_email: providerEmail,
      user_phone: patientPhone,
      provider_phone: providerPhone,
      email_persona: opts.email_persona,
      voice_persona: opts.voice_persona,
      final_acceptable_floor: opts.final_acceptable_floor,
      max_email_rounds: opts.max_email_rounds,
      channels_enabled: opts.channels_enabled,
      user_directives: opts.user_directives,
      agent_tone: opts.agent_tone,
      cc: opts.cc,
    });
    report.persistent_run = run;
    // Surface the transcripts in the existing thread fields so the current
    // UI renders them without rewriting.
    if (run.email) {
      report.email_thread = {
        thread_id: run.attempts.find((a) => a.channel === "email")?.thread_id ?? "",
        state: run.email.state,
        messages: run.email.messages,
      };
    }
    if (run.voice) {
      report.voice_call = {
        call_id: run.attempts.find((a) => a.channel === "voice")?.call_id ?? "",
        state: run.voice.state,
        transcript: run.voice.transcript,
      };
    }
    report.summary.final_balance = run.best?.final_amount ?? null;
    report.summary.patient_saved = run.best?.saved ?? null;
    report.summary.outcome =
      run.outcome === "in_progress"
        ? "in_progress"
        : run.outcome === "exhausted_no_offer"
          ? "escalated"
          : "resolved";
    report.summary.outcome_detail = run.headline;
    return report;
  }

  if (strategy.chosen === "email") {
    // Synthetic recipient guard. Sample fixtures pre-seed contacts with
    // .example / .test / .invalid TLDs (e.g. billing@stsynthetic.example)
    // because we don't ship real provider addresses in the demo data.
    // Resend rejects those domains as undeliverable, which used to surface
    // as a generic "agent error" on the negotiation list right after the
    // user clicked Accept. Detect them up-front and route through the
    // simulator so the sample demos end-to-end regardless of env.
    const synthetic = isSyntheticEmail(providerEmail);
    const client = synthetic
      ? new MockEmailClient()
      : await autoEmailClient();
    const isReal = !synthetic && !(client instanceof MockEmailClient);
    const { thread_id, state: initState } = await startNegotiation({
      analyzer,
      client,
      user_email: patientEmail,
      provider_email: providerEmail,
      final_acceptable_floor: opts.final_acceptable_floor,
      user_directives: opts.user_directives,
      agent_tone: opts.agent_tone,
      cc: opts.cc,
    });
    let state = initState;
    saveNegotiationState(state);

    const maxRounds = opts.max_email_rounds ?? 4;
    if (!isReal) {
      // Demo mode — synthetic loop. Real mode dispatches one email and
      // waits for the inbound webhook to step the agent on actual replies.
      for (let round = 1; round <= maxRounds; round++) {
        const thread = loadThread(thread_id);
        const latest = thread.outbound[thread.outbound.length - 1];
        await simulateReply({
          thread_id,
          turn_number: round,
          persona: opts.email_persona ?? "stall_then_concede",
          analyzer,
          provider_email: providerEmail,
          user_email: patientEmail,
          reply_to_subject: latest?.subject ?? report.appeal.subject,
          latest_outbound_body: latest?.body_markdown ?? "",
          client: client as MockEmailClient,
        });
        state = await stepNegotiation({ state, client });
        saveNegotiationState(state);
        if (state.outcome.status !== "in_progress") break;
      }
    }

    const final = loadThread(thread_id);
    const messages: ThreadMessage[] = [];
    for (const m of final.outbound) {
      messages.push({ role: "outbound", subject: m.subject, body: m.body_markdown, ts: m.sent_at });
    }
    for (const m of final.inbound) {
      messages.push({ role: "inbound", subject: m.subject, body: m.body_text, ts: m.received_at });
    }
    messages.sort((a, b) => a.ts.localeCompare(b.ts));

    report.email_thread = { thread_id, state, messages };

    if (state.outcome.status === "resolved") {
      report.summary.outcome = "resolved";
      report.summary.final_balance = state.outcome.final_amount_owed;
      // Clamp savings to [0, originalBalance]. Saving more than the bill
      // existed for in the first place isn't possible — and a negative
      // "saved" (final > original) means the agent inflated the bill,
      // which we treat as zero savings rather than confusing the user.
      report.summary.patient_saved = Math.max(
        0,
        Math.min(originalBalance, originalBalance - state.outcome.final_amount_owed),
      );
      report.summary.outcome_detail = `Email negotiation resolved — ${state.outcome.resolution}. ${state.outcome.notes}`;
    } else if (state.outcome.status === "escalated") {
      report.summary.outcome = "escalated";
      report.summary.outcome_detail = `Escalated to human: ${state.outcome.reason}. ${state.outcome.notes}`;
    } else {
      report.summary.outcome = "in_progress";
      report.summary.outcome_detail = `Still in progress after ${maxRounds} rounds.`;
    }
  } else {
    // voice
    const { call_id, state, transcript } = await simulateCall({
      analyzer,
      persona: opts.voice_persona ?? "cooperative",
      final_acceptable_floor: opts.final_acceptable_floor,
      max_turns: 14,
    });
    report.voice_call = {
      call_id,
      state,
      transcript: transcript.map((t) => ({ who: t.who, text: t.text })),
    };

    if (state.outcome.status === "success" || state.outcome.status === "partial") {
      report.summary.outcome = "resolved";
      report.summary.final_balance = state.outcome.negotiated_amount ?? null;
      if (state.outcome.negotiated_amount != null) {
        report.summary.patient_saved = Math.max(
          0,
          Math.min(originalBalance, originalBalance - state.outcome.negotiated_amount),
        );
      }
      report.summary.outcome_detail = `Voice call ${state.outcome.status}. ${state.outcome.commitment_notes ?? ""}`;
    } else if (state.outcome.status === "handoff" || state.outcome.status === "voicemail_left") {
      report.summary.outcome = "escalated";
      report.summary.outcome_detail = `Voice call ended with ${state.outcome.status}${state.outcome.handoff_reason ? ` (${state.outcome.handoff_reason})` : ""}.`;
    } else {
      report.summary.outcome = state.outcome.status === "no_adjustment" ? "escalated" : "in_progress";
      report.summary.outcome_detail = `Voice call ended: ${state.outcome.status}.`;
    }
  }

  return report;
}

/**
 * Legacy one-shot: runs audit + negotiation back to back. Kept so existing
 * callers that don't need the review step still work.
 */
export async function runBonsai(opts: RunBonsaiOpts): Promise<BonsaiReport> {
  const partial = await runAuditPhase(opts);
  return runNegotiationPhase(partial, opts);
}

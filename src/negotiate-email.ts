/**
 * Email negotiation loop.
 *
 * Given an AnalyzerResult + patient contact info + billing department email,
 * this module:
 *   1. Sends the initial appeal letter as email #1.
 *   2. For each subsequent inbound reply, asks Claude to classify the reply
 *      (concession / partial_concession / stall / denial / request_info)
 *      and draft a response using the same grounded-quote rules as the
 *      analyzer.
 *   3. Terminates when Claude calls mark_resolved (with an outcome) or
 *      escalate_human (with a reason).
 *
 * Claude has three tools:
 *   - send_email: draft + send the next outbound message
 *   - mark_resolved: outcome = reduced | full_adjustment | no_adjustment
 *   - escalate_human: reason = hostile | legal | unclear | deadlock
 *
 * We DO NOT let Claude make settlement promises. The `final_acceptable_floor`
 * is set by the operator (CLI flag or UI), and Claude's system prompt caps
 * any concessions at that floor.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { EmailClient, OutboundEmail, SentEmail, InboundEmail } from "./clients/email.ts";
import type { AnalyzerResult, BillKind } from "./types.ts";
import { generateAppealLetter } from "./appeal-letter.ts";
import { loadThread, saveThread } from "./clients/email-mock.ts";
import { newId } from "./clients/email.ts";
import type { AgentTone, AgentMode } from "./lib/user-settings.ts";
import { toneGuidance } from "./lib/feedback-parser.ts";
import { humanize } from "./lib/humanizer.ts";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 2048;
const MAX_TURNS_PER_STEP = 4;
/** Push-back rounds the user can request before the third proposal forces
 * an escalation with reason "user_judgment_required". 2 rounds matches the
 * existing system-prompt "after 2-3 denials, escalate" guidance. */
export const MAX_PUSH_BACK_ROUNDS = 2;

export type ResolutionKind = "full_adjustment" | "reduced" | "no_adjustment";

export type EscalationReason =
  | "hostile"
  | "legal"
  | "unclear"
  | "deadlock"
  | "user_judgment_required";

export type NegotiationOutcome =
  | { status: "in_progress" }
  | {
      status: "resolved";
      resolution: ResolutionKind;
      final_amount_owed: number;
      notes: string;
      /** True when the rep is asking the user to sign anything binding
       * (insurance release, debt-settlement agreement, lease addendum,
       * "reply YES to confirm"). Set even though the status is "resolved"
       * — the resolved record persists the fact that a signature was asked
       * for and accepted by the user. */
      requires_signature?: boolean;
      signature_doc_summary?: string;
    }
  | {
      status: "awaiting_user_review";
      resolution: ResolutionKind;
      proposed_amount: number;
      summary: string;
      push_back_count: number;
      /** When true, the autonomous-mode auto-close was overridden because
       * the rep asked the user to sign something. The user MUST review. */
      requires_signature?: boolean;
      signature_doc_summary?: string;
    }
  | { status: "escalated"; reason: EscalationReason; notes: string };

export interface NegotiationState {
  thread_id: string;
  analyzer: AnalyzerResult;
  user_email: string;
  provider_email: string;
  /** Lowest final amount the patient is willing to pay for this claim. */
  final_acceptable_floor: number;
  /** History of message ids seen, to drive loop termination. */
  last_seen_inbound_ts: string;
  /** ISO timestamp of the most recent outbound email we sent. Used by the
   * persistent-mode advance pass to compute working-hours-elapsed since
   * the last contact attempt. */
  email_outbound_sent_at?: string;
  /** ISO timestamp of the most recent inbound reply observed. Distinct
   * from `last_seen_inbound_ts` (which only advances after a successful
   * step) — this is the raw "did we hear back at all" signal. */
  last_inbound_received_at?: string | null;
  /** PendingRun id this thread belongs to. Set by persistent-mode kickoff
   * so the advance pass can look up provider phone + contact when
   * escalating to voice. Undefined for stand-alone CLI runs. */
  run_id?: string;
  /** ISO timestamp set when the advance pass dialed voice for this thread.
   * Idempotent gate — once set, advance does not redial. */
  escalated_to_voice_at?: string;
  outcome: NegotiationOutcome;
  /** Free-form user directives from the feedback drawer (e.g. "only email, no
   * calls", "don't mention hardship yet"). Prepended to the system prompt on
   * every turn so the agent actually honors them. */
  user_directives?: string;
  /** Tone the user asked the agent to strike. Adjusts system prompt wording. */
  agent_tone?: AgentTone;
  /** Compact summary of prior negotiation attempts on other channels.
   * Injected into the analyzer context so a later-channel agent knows the
   * history (e.g., "email got partial concession on line A, refused line B"). */
  prior_attempts_summary?: string;
  /** CC recipients on every outbound email the agent sends — typically the
   * user's own email. Visible by design: shows the rep there's a real
   * account holder on the line and lets them Reply-All to keep the user
   * in sync. The webhook backstops Reply-by-itself by forwarding rep
   * replies. */
  cc?: string[];
  /** Mode locked at thread creation. Controls whether `mark_resolved` from
   * the agent terminates immediately ("autonomous") or routes through a
   * user accept/push-back gate ("copilot"). Snapshotted onto state — never
   * read from `user-settings` mid-thread. */
  agent_mode?: AgentMode;
  /** Monotonic mutation counter. Incremented on every state save. The
   * accept/push-back endpoints accept `If-Match: <seq>` and 412 on
   * mismatch so a stale UI can't clobber a later mutation. */
  seq?: number;
  /** Number of push-back rounds the user has issued on this thread. After
   * MAX_PUSH_BACK_ROUNDS, the next agent proposal is force-escalated with
   * reason "user_judgment_required". */
  push_back_count?: number;
}

function buildSystemPrompt(
  state: Pick<NegotiationState, "user_directives" | "agent_tone" | "agent_mode" | "push_back_count">,
): string {
  const parts: string[] = [SYSTEM_PROMPT];
  if (state.agent_tone) {
    parts.push(
      `\n\n## User-specified tone: ${state.agent_tone}\n\n${toneGuidance(state.agent_tone)}`,
    );
  }
  // Mode-specific closing instruction. Autonomous closes anything at or
  // below the floor without asking; co-pilot returns every proposed
  // resolution to the user for accept/push-back. The signature rule
  // applies in both modes — see SYSTEM_PROMPT.
  const mode: AgentMode = state.agent_mode ?? "autonomous";
  if (mode === "copilot") {
    const remaining = Math.max(0, MAX_PUSH_BACK_ROUNDS - (state.push_back_count ?? 0));
    parts.push(
      `\n\n## Mode: co-pilot\n\nMark resolved when the rep agrees to a final figure. The user will then accept the resolution or instruct you to push back; you do not close threads on your own. The user has ${remaining} push-back round${remaining === 1 ? "" : "s"} remaining.`,
    );
  } else {
    parts.push(
      `\n\n## Mode: autonomous\n\nClose anything at or below the final_acceptable_floor without asking. The user has authorized you to settle on their behalf. Notify-on-resolution happens automatically; you do NOT need to "check in" before mark_resolved.`,
    );
  }
  if (state.user_directives && state.user_directives.trim()) {
    parts.push(
      `\n\n## User directives (from the patient — must be honored)\n\n${state.user_directives.trim()}`,
    );
  }
  return parts.join("");
}

const SYSTEM_PROMPT = `You are Bonsai, an email negotiator acting on behalf of a customer. You exchange email with a provider's billing, support, or retention team over multiple rounds. Your goal: lower the bill or get the outcome the customer asked for, using only facts the analyzer grounded.

A separate humanizer pass rewrites every outbound email before it's sent — it handles tone, brevity, and stripping AI-isms. Don't worry about polishing the surface language yourself. Focus on substance: the right ask, the right facts, the right next move.

## Ground rules (strict)

1. Only quote facts from the analyzer's findings. Every dollar figure and every line_quote in your reply must come from the analyzer result you were given in the opening user message. Do not invent claim numbers, account numbers, CPT codes, dates, or amounts.
2. If you don't have a value (claim #, account #, date of service), OMIT it entirely. Never write "[CLAIM NUMBER]", "TBD", "Unknown", or invent one. The humanizer will drop empty placeholders, but it's safer to leave them out yourself.
3. If the rep asks for an identifier you don't have AND the negotiation can't continue without it (e.g. they refuse to look up the account), call escalate_human with reason=unclear and include the missing field in the notes — the user will be prompted to provide it.
4. Be factual and direct. The humanizer will dial tone — your job is to pick the right move.
5. If a reply concedes to the customer's target or lower, call mark_resolved with resolution=full_adjustment.
6. If a reply offers a reduced amount that's at or below the final_acceptable_floor, call mark_resolved with resolution=reduced.
7. If a reply denies the dispute outright, push back once with the strongest grounded fact (EOB, contract terms, the original price). After 2-3 denials with no movement, escalate_human with reason=deadlock.
8. If a reply is hostile, contains legal threats, or references collections/attorneys, escalate_human immediately.

## Signature rule (applies in BOTH modes — autonomous and co-pilot)

If the rep proposes a settlement that requires the user to sign, initial, or otherwise commit to anything binding — including:
- Insurance settlement releases
- Debt-settlement agreements
- Lease addenda or rent-concession agreements
- "Reply YES to confirm" or "click this link to accept"
- Any document the user must sign before the resolution takes effect

…then call mark_resolved with requires_signature=true and a one-sentence signature_doc_summary describing what they're being asked to sign. When you set requires_signature=true, the user is ALWAYS notified for review — the agent does NOT auto-close, even in autonomous mode. When in doubt, set it to true.

## Who to address

Target the right department on the FIRST email and re-target if the rep routes you wrong:

- Medical bills → billing department / patient accounts
- Telecom, subscription, insurance → retention or customer-loyalty team. Never sales reps. If a rep introduces themselves as sales or tries to push you into a "new offer", politely ask to be transferred to the retention team or a retention officer (or "loyalty specialist", whatever they call it).
- Utility / financial → customer support / billing / disputes team
- Other → customer support

When in doubt, address "Customer Support — Billing" rather than a specific person.

## Talk-track for recurring-charge bills (telecom, subscription, insurance)

For these bill kinds, the leverage is your ability to leave. The first email should hit four beats — keep them brief, the humanizer will polish:

1. "I noticed this price increase / charge."
2. "I can no longer continue at this rate; I'm comparing other providers / shopping around."
3. "I've been a loyal customer for [duration]." (only if true and known)
4. The ask, quantified: months of credit, return to the prior rate, or specific dollar amount off. Push for the maximum reasonable — they'll often counter.

If they offer a lesser concession, push back once before accepting. If they say "no movement", politely ask to escalate to a retention officer / supervisor.

## Talk-track for medical / utility / financial / one-off disputes

These are factual disputes — the leverage is the audit, not departure. Lead with: the specific charge, why it's wrong (verbatim from the analyzer), the corrected amount, the deadline. Keep statute citations only if the analyzer included them; the humanizer won't add new ones.

## Tool-use order

You will be called once per turn. On each turn you MUST do exactly one of:
- Call send_email with the next outbound message.
- Call mark_resolved.
- Call escalate_human.

Do NOT emit prose; the tool call is your entire output.

## Email style (the humanizer handles polish — keep your draft factual)

- Subject for replies: keep the original subject; prepend "Re: " if not already there.
- Subject hard cap: under 60 characters.
- Body length is enforced by the humanizer. Hard caps:
  - Initial outreach: under 200 words.
  - Follow-ups: under 120 words.
  Cut anything not load-bearing — quotes, ask, deadline. That's the whole shape.
- No markdown. The body ships as plain text — \`**bold**\` renders as literal asterisks, \`## headings\` as literal hashes, backticks as literal backticks. Forbidden: \`**\`, \`__\`, \`_x_\`, \`*x*\`, \`# headings\`, \`> blockquotes\`, backticks. Hyphen-space bullets (\`- item\`) are fine because they read as plain text. Snake_case identifiers (claim_number, account_number) are fine — they're not emphasis.
- Don't open with "I hope this email finds you well", "I am writing to formally", or other AI-isms — the humanizer will strip them, but skipping them yourself saves a hop.
- Reference the original appeal letter ("as documented in my initial dispute") rather than re-attaching the whole findings list on follow-ups.`;

const SEND_EMAIL_TOOL: Anthropic.Tool = {
  name: "send_email",
  description:
    "Draft and send the next outbound email in the negotiation thread. This sends the message immediately; do not compose a draft and then call this as a preview.",
  input_schema: {
    type: "object",
    required: ["subject", "body_text"],
    properties: {
      subject: {
        type: "string",
        minLength: 3,
        description: "Subject line. For replies, preserve the original subject with 'Re: ' prefix.",
      },
      body_text: {
        type: "string",
        minLength: 50,
        description:
          "Plain-text email body. Do NOT use markdown formatting — the message ships as plain text, so any markdown punctuation renders as literal characters in Gmail/Outlook. Forbidden: `**bold**`, `__bold__`, `_italic_`, `*italic*`, `# Headings`, `> blockquotes`, and backticks. Hyphen-space bullets (`- item`) are fine because they read as plain text. Include a greeting, 1–3 short paragraphs, and a signature block.\n\nDo: We're disputing the $900 balance-billing charge on claim CLM-001. Per the EOB, patient responsibility is $100.\nDon't: **We are disputing** the `$900` balance-billing charge on _claim CLM-001_. ## Background — per the EOB, patient responsibility is $100.",
      },
    },
  },
};

const MARK_RESOLVED_TOOL: Anthropic.Tool = {
  name: "mark_resolved",
  description:
    "Call when the billing department has agreed to correct the account or reduce the balance to an acceptable amount. In autonomous mode this terminates the thread. In co-pilot mode it routes the proposed resolution to the user for accept/push-back. If the rep is asking the user to sign anything binding, set requires_signature=true and the user will always be asked to confirm regardless of mode.",
  input_schema: {
    type: "object",
    required: ["resolution", "final_amount_owed", "notes"],
    properties: {
      resolution: {
        type: "string",
        enum: ["full_adjustment", "reduced", "no_adjustment"],
        description:
          "full_adjustment = balance reduced to EOB responsibility or below; reduced = between EOB and original bill but at/under final_acceptable_floor; no_adjustment = patient conceded original balance (should be rare).",
      },
      final_amount_owed: {
        type: "number",
        minimum: 0,
        description: "Final dollar amount the patient owes after resolution.",
      },
      notes: {
        type: "string",
        minLength: 10,
        description: "1–3 sentence summary of how we got here and what the provider committed to.",
      },
      requires_signature: {
        type: "boolean",
        description:
          "True when the rep is asking the user to sign, initial, or otherwise commit to a binding document (insurance release, debt-settlement agreement, lease addendum, 'reply YES to confirm', etc). When true, the user is ALWAYS asked to review before the resolution is final, even in autonomous mode. When in doubt, set true.",
      },
      signature_doc_summary: {
        type: "string",
        description:
          "Required when requires_signature=true. One-sentence plain-English description of what the user is being asked to sign (e.g., 'a release of all future claims related to this hospital stay').",
      },
    },
  },
};

const ESCALATE_HUMAN_TOOL: Anthropic.Tool = {
  name: "escalate_human",
  description:
    "Call when the situation needs a human: hostile reply, legal threats, deadlock after 3 denials, or unclear/missing info.",
  input_schema: {
    type: "object",
    required: ["reason", "notes"],
    properties: {
      reason: {
        type: "string",
        enum: ["hostile", "legal", "unclear", "deadlock", "user_judgment_required"],
      },
      notes: { type: "string", minLength: 10 },
    },
  },
};

/**
 * Decide what an agent's `mark_resolved` call becomes on `state.outcome`.
 * Three paths:
 *  - `requires_signature=true` → ALWAYS gate (override autonomous mode).
 *    The user must explicitly confirm any binding signature.
 *  - autonomous mode → close immediately, status=resolved.
 *  - copilot mode → gate as awaiting_user_review, OR force-escalate
 *    when the user has already exhausted MAX_PUSH_BACK_ROUNDS rounds.
 *    Escalation reason is "user_judgment_required" so the UI can surface
 *    "you've been pushing back; we need you to make the final call."
 */
function resolveOrGate(
  state: Pick<NegotiationState, "agent_mode" | "push_back_count">,
  input: {
    resolution: ResolutionKind;
    final_amount_owed: number;
    notes: string;
    requires_signature?: boolean;
    signature_doc_summary?: string;
  },
): NegotiationOutcome {
  const requires_signature = !!input.requires_signature;
  const sigSummary = requires_signature ? input.signature_doc_summary?.trim() || undefined : undefined;
  const mode: AgentMode = state.agent_mode ?? "autonomous";
  const pushBacks = state.push_back_count ?? 0;

  if (!requires_signature && mode === "autonomous") {
    return {
      status: "resolved",
      resolution: input.resolution,
      final_amount_owed: input.final_amount_owed,
      notes: input.notes,
    };
  }
  // copilot or signature-required path. If the user has already used up
  // their push-back budget, force-escalate instead of looping a third time.
  if (mode === "copilot" && pushBacks >= MAX_PUSH_BACK_ROUNDS) {
    return {
      status: "escalated",
      reason: "user_judgment_required",
      notes: `User has exhausted ${MAX_PUSH_BACK_ROUNDS} push-back rounds. Latest agent proposal: ${input.notes} Final amount: $${input.final_amount_owed.toFixed(2)}.`,
    };
  }
  return {
    status: "awaiting_user_review",
    resolution: input.resolution,
    proposed_amount: input.final_amount_owed,
    summary: input.notes,
    push_back_count: pushBacks,
    requires_signature: requires_signature || undefined,
    signature_doc_summary: sigSummary,
  };
}

function renderThreadForClaude(thread: { outbound: SentEmail[]; inbound: InboundEmail[] }): string {
  const items: Array<{ ts: string; role: "us" | "them"; body: string; subject: string }> = [];
  for (const m of thread.outbound) {
    items.push({ ts: m.sent_at, role: "us", subject: m.subject, body: m.body_text });
  }
  for (const m of thread.inbound) {
    items.push({ ts: m.received_at, role: "them", subject: m.subject, body: m.body_text });
  }
  items.sort((a, b) => a.ts.localeCompare(b.ts));
  if (items.length === 0) return "(thread empty — you have not sent the initial appeal yet)";
  return items
    .map(
      (it, i) =>
        `--- message ${i + 1} (${it.role === "us" ? "OUTBOUND (you)" : "INBOUND (billing dept)"}) ts=${it.ts} ---\nSubject: ${it.subject}\n\n${it.body}`,
    )
    .join("\n\n");
}

/**
 * Build the list of grounded facts the humanizer is told to preserve
 * verbatim. These are the values an LLM rewrite must NOT paraphrase or
 * round — claim numbers, dollar figures, the analyzer's exact line_quotes.
 * If a field is null we skip it; the humanizer is also told to drop empty
 * placeholders, but providing a tight list helps it decide what to keep.
 */
function collectPreserveFacts(result: AnalyzerResult): string[] {
  const out: string[] = [];
  const m = result.metadata;
  if (m.claim_number) out.push(`Claim number: ${m.claim_number}`);
  if (m.account_number) out.push(`Account number: ${m.account_number}`);
  if (m.date_of_service) out.push(`Date of service: ${m.date_of_service}`);
  if (m.eob_patient_responsibility != null) {
    out.push(`EOB patient responsibility: $${m.eob_patient_responsibility.toFixed(2)}`);
  }
  if (m.bill_current_balance_due != null) {
    out.push(`Bill current balance due: $${m.bill_current_balance_due.toFixed(2)}`);
  }
  for (const e of result.errors.filter((e) => e.confidence === "high")) {
    out.push(`Disputed line ($${e.dollar_impact.toFixed(2)}): "${e.line_quote.trim()}"`);
  }
  return out;
}

function renderAnalyzerContext(
  result: AnalyzerResult,
  floor: number,
  priorAttemptsSummary?: string,
): string {
  const high = result.errors.filter((e) => e.confidence === "high");
  const byType: Record<string, number> = {};
  for (const e of high) byType[e.error_type] = (byType[e.error_type] ?? 0) + e.dollar_impact;

  const priorBlock =
    priorAttemptsSummary && priorAttemptsSummary.trim()
      ? `\n${priorAttemptsSummary.trim()}\n`
      : "";

  return `## Dispute context (from grounded analyzer output)

Patient: ${result.metadata.patient_name ?? "(unknown)"}
Provider: ${result.metadata.provider_name ?? "(unknown)"}
Claim #: ${result.metadata.claim_number ?? "(unknown)"}
Date of service: ${result.metadata.date_of_service ?? "(unknown)"}
Insurer: ${result.metadata.insurer_name ?? "(unknown)"}

Bill current balance due: $${result.metadata.bill_current_balance_due?.toFixed(2) ?? "?"}
EOB patient responsibility: $${result.metadata.eob_patient_responsibility?.toFixed(2) ?? "?"}
Defensible total disputed (HIGH): $${result.summary.high_confidence_total.toFixed(2)}

Final acceptable floor (do not settle above this): $${floor.toFixed(2)}

## HIGH-confidence findings

${high
  .map(
    (e, i) =>
      `${i + 1}. [${e.error_type}]${e.cpt_code ? ` CPT ${e.cpt_code}` : ""} $${e.dollar_impact.toFixed(2)}
   Bill quote (verbatim): "${e.line_quote.trim()}"
   Evidence: ${e.evidence.trim()}`,
  )
  .join("\n")}
${priorBlock}`;
}

export interface StartOpts {
  analyzer: AnalyzerResult;
  client: EmailClient;
  user_email: string;
  provider_email: string;
  final_acceptable_floor?: number; // defaults to eob patient responsibility
  user_directives?: string;
  agent_tone?: AgentTone;
  /** Mode for this thread. Snapshotted onto state at creation; mid-thread
   * settings changes don't affect in-flight threads. Defaults to autonomous. */
  agent_mode?: AgentMode;
  /** Compact summary of prior negotiation attempts on other channels.
   * Stored on state so every step's analyzer context includes it. */
  prior_attempts_summary?: string;
  /** CC recipients (typically the user's email) copied on every outbound.
   * Persisted on NegotiationState so follow-ups reuse the list. */
  cc?: string[];
  /** PendingRun id this thread belongs to. Persisted on NegotiationState
   * so the persistent-mode advance pass can look up provider_phone +
   * contact for voice escalation without scanning every run on disk. */
  run_id?: string;
  /** Optional Anthropic client. Tests inject a mock; production callers
   * leave undefined and a fresh client is created. Forwarded to the
   * humanizer so its outbound rewrite reuses the same mock. */
  anthropic?: Anthropic;
}

export interface StartResult {
  thread_id: string;
  sent: SentEmail;
  state: NegotiationState;
}

/**
 * Kick off the negotiation: compose + send the initial appeal letter, return
 * the new NegotiationState. Does NOT wait for a reply — caller should poll
 * via step() when inbound arrives (or run the simulator which generates one).
 */
export async function startNegotiation(opts: StartOpts): Promise<StartResult> {
  const { analyzer, client, user_email, provider_email } = opts;
  const floor = opts.final_acceptable_floor ?? analyzer.metadata.eob_patient_responsibility ?? 0;
  const thread_id = newId("thread");
  const letter = generateAppealLetter(analyzer);

  // Humanizer pass — rewrites the deterministic appeal letter to apply
  // the user's tone preference, the bill-kind playbook, and to strip any
  // template stiffness. Grounded facts (line quotes, dollar figures) are
  // preserved verbatim per the humanizer's system prompt. Reuses the
  // injected Anthropic client so tests can mock it.
  const billKind = analyzer.metadata.bill_kind;
  const humanized = await humanize({
    body: letter.markdown,
    subject: letter.subject,
    tone: opts.agent_tone,
    bill_kind: billKind,
    is_first_contact: true,
    user_name: analyzer.metadata.patient_name,
    preserve_facts: collectPreserveFacts(analyzer),
    anthropic: opts.anthropic,
  });

  const msg: OutboundEmail = {
    to: provider_email,
    from: user_email,
    subject: humanized.subject,
    body_text: humanized.body,
    thread_id,
    cc: opts.cc,
  };
  const sent = await client.send(msg);

  const state: NegotiationState = {
    thread_id,
    analyzer,
    user_email,
    provider_email,
    final_acceptable_floor: floor,
    last_seen_inbound_ts: new Date(0).toISOString(),
    email_outbound_sent_at: new Date().toISOString(),
    last_inbound_received_at: null,
    outcome: { status: "in_progress" },
    user_directives: opts.user_directives,
    agent_tone: opts.agent_tone,
    agent_mode: opts.agent_mode ?? "autonomous",
    prior_attempts_summary: opts.prior_attempts_summary,
    cc: opts.cc,
    run_id: opts.run_id,
    seq: 0,
    push_back_count: 0,
  };
  return { thread_id, sent, state };
}

export interface StepOpts {
  state: NegotiationState;
  client: EmailClient;
  anthropic?: Anthropic;
  /** Override on-disk thread directory. Defaults to out/threads/. Tests
   * use this to point at a tmpdir so parallel runs don't collide. */
  threadsDir?: string;
}

/**
 * Advance the negotiation one step. Reads any new inbound messages on the
 * thread, asks Claude to decide the next action, executes it, returns the
 * updated NegotiationState.
 *
 * Caller invokes this every time a new inbound message arrives (e.g., after
 * the webhook handler writes an InboundEmail into the thread file).
 */
export async function stepNegotiation(opts: StepOpts): Promise<NegotiationState> {
  const { state, client } = opts;
  const anthropic = opts.anthropic ?? new Anthropic();

  if (state.outcome.status !== "in_progress") return state;

  const thread = loadThread(state.thread_id, opts.threadsDir);
  const inboundSinceLast = thread.inbound.filter(
    (m) => Date.parse(m.received_at) > Date.parse(state.last_seen_inbound_ts),
  );
  if (inboundSinceLast.length === 0) return state; // nothing to do

  const context = renderAnalyzerContext(
    state.analyzer,
    state.final_acceptable_floor,
    state.prior_attempts_summary,
  );
  const rendered = renderThreadForClaude(thread);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `${context}\n\n## Thread so far (newest inbound is the message to respond to)\n\n${rendered}\n\n## Your task\n\nDecide the next action. Call exactly one of: send_email, mark_resolved, escalate_human.`,
    },
  ];

  let newOutcome: NegotiationOutcome = { status: "in_progress" };
  let terminatedCleanly = false;
  let outboundSentAt: string | undefined;

  for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(state),
      tools: [SEND_EMAIL_TOOL, MARK_RESOLVED_TOOL, ESCALATE_HUMAN_TOOL],
      messages,
    });

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    let terminated = false;

    for (const block of toolUses) {
      if (block.name === "send_email") {
        const input = block.input as { subject: string; body_text: string };
        const lastInbound = inboundSinceLast[inboundSinceLast.length - 1];
        // Humanizer pass on every follow-up. Same contract as the initial
        // letter — preserves grounded facts, applies tone + playbook, strips
        // AI-isms. is_first_contact: false so the humanizer doesn't open
        // with introductions.
        const humanized = await humanize({
          body: input.body_text,
          subject: input.subject,
          tone: state.agent_tone,
          bill_kind: state.analyzer.metadata.bill_kind,
          is_first_contact: false,
          user_name: state.analyzer.metadata.patient_name,
          preserve_facts: collectPreserveFacts(state.analyzer),
          anthropic,
        });
        const out: OutboundEmail = {
          to: state.provider_email,
          from: state.user_email,
          subject: humanized.subject,
          body_text: humanized.body,
          thread_id: state.thread_id,
          in_reply_to: lastInbound?.message_id,
          cc: state.cc,
        };
        const sent = await client.send(out);
        outboundSentAt = sent.sent_at ?? new Date().toISOString();
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Email sent. message_id=${sent.message_id}. Waiting on their reply. Do not send another message until they respond.`,
        });
        terminated = true;
      } else if (block.name === "mark_resolved") {
        const input = block.input as {
          resolution: ResolutionKind;
          final_amount_owed: number;
          notes: string;
          requires_signature?: boolean;
          signature_doc_summary?: string;
        };
        newOutcome = resolveOrGate(state, input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content:
            newOutcome.status === "awaiting_user_review"
              ? "Resolution recorded; user has been asked to review."
              : newOutcome.status === "escalated"
                ? "Force-escalated: user has exhausted push-back rounds."
                : "Resolution recorded; thread closed.",
        });
        terminated = true;
      } else if (block.name === "escalate_human") {
        const input = block.input as { reason: EscalationReason; notes: string };
        newOutcome = { status: "escalated", reason: input.reason, notes: input.notes };
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Escalated to human." });
        terminated = true;
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Unknown tool: ${block.name}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
    if (terminated) {
      terminatedCleanly = true;
      break;
    }
  }

  // If Claude burned through MAX_TURNS_PER_STEP without ever calling a
  // terminal tool, we'd otherwise advance last_seen_inbound_ts and silently
  // freeze the thread. Force an escalation instead — the operator can pick
  // it up and decide what to do.
  if (!terminatedCleanly) {
    newOutcome = {
      status: "escalated",
      reason: "unclear",
      notes: `Agent did not produce a terminal tool call within ${MAX_TURNS_PER_STEP} turns; escalating for human review.`,
    };
  }

  const latestTs = inboundSinceLast[inboundSinceLast.length - 1].received_at;
  const nextState: NegotiationState = {
    ...state,
    last_seen_inbound_ts: latestTs,
    last_inbound_received_at: latestTs,
    email_outbound_sent_at: outboundSentAt ?? state.email_outbound_sent_at,
    outcome: newOutcome,
    seq: (state.seq ?? 0) + 1,
  };
  return nextState;
}

export interface UserPushBackOpts {
  state: NegotiationState;
  client: EmailClient;
  /** Free-text or structured-chip note from the user — appended to
   * user_directives so the next agent turn honors it. */
  note: string;
  anthropic?: Anthropic;
  threadsDir?: string;
}

/**
 * User pushed back on a proposed resolution. Different shape from
 * stepNegotiation — there's no new inbound to respond to. We're driving the
 * agent to compose a fresh follow-up referencing the rep's last offer plus
 * the user's note.
 *
 * Push-back budget is enforced two ways:
 *  - At entry: if push_back_count is already >= MAX_PUSH_BACK_ROUNDS, we
 *    refuse and force-escalate without burning an LLM turn.
 *  - At resolution: resolveOrGate also force-escalates if the agent tries
 *    to propose again at count >= MAX_PUSH_BACK_ROUNDS. This is the path
 *    taken when this driver IS allowed to run and the agent comes back
 *    with another mark_resolved on the next round.
 */
export async function stepNegotiationOnUserPushBack(
  opts: UserPushBackOpts,
): Promise<NegotiationState> {
  const { state, client, note } = opts;
  const anthropic = opts.anthropic ?? new Anthropic();

  if (state.outcome.status !== "awaiting_user_review") {
    // Idempotency / race: another mutation already advanced the state.
    // Caller should have verified `seq` before invoking; bail rather than
    // double-step.
    return state;
  }

  const currentPushBacks = state.push_back_count ?? 0;
  const trimmedNote = note.trim();
  const newDirectives = [state.user_directives?.trim(), trimmedNote ? `Push-back round ${currentPushBacks + 1}: ${trimmedNote}` : null]
    .filter(Boolean)
    .join("\n\n");

  // Budget exhausted? Force-escalate now without an LLM turn.
  if (currentPushBacks >= MAX_PUSH_BACK_ROUNDS) {
    return {
      ...state,
      outcome: {
        status: "escalated",
        reason: "user_judgment_required",
        notes: `User attempted push-back round ${currentPushBacks + 1}; budget is ${MAX_PUSH_BACK_ROUNDS}. Latest user note: ${trimmedNote || "(empty)"}.`,
      },
      push_back_count: currentPushBacks + 1,
      seq: (state.seq ?? 0) + 1,
    };
  }

  const thread = loadThread(state.thread_id, opts.threadsDir);
  const context = renderAnalyzerContext(
    state.analyzer,
    state.final_acceptable_floor,
    state.prior_attempts_summary,
  );
  const rendered = renderThreadForClaude(thread);

  // The state we hand the agent has push_back_count incremented (so the
  // mode-specific system-prompt block tells it "X push-back rounds remain")
  // and outcome reset to in_progress so it doesn't short-circuit.
  const draftState: NegotiationState = {
    ...state,
    outcome: { status: "in_progress" },
    user_directives: newDirectives,
    push_back_count: currentPushBacks + 1,
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${context}\n\n## Thread so far\n\n${rendered}\n\n## User push-back\n\nThe user reviewed your previous proposed resolution and pushed back. Their note: "${trimmedNote || "(no specific guidance)"}".\n\nCompose the next outbound message that pushes back on the rep's last offer, incorporating the user's guidance. Call send_email with the next message; do NOT call mark_resolved on this turn (the user just rejected the prior resolution).`,
    },
  ];

  let outboundSentAt: string | undefined;
  let nextOutcome: NegotiationOutcome = { status: "in_progress" };
  let terminated = false;

  for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(draftState),
      tools: [SEND_EMAIL_TOOL, MARK_RESOLVED_TOOL, ESCALATE_HUMAN_TOOL],
      messages,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const block of toolUses) {
      if (block.name === "send_email") {
        const input = block.input as { subject: string; body_text: string };
        const lastInbound = thread.inbound[thread.inbound.length - 1];
        const humanized = await humanize({
          body: input.body_text,
          subject: input.subject,
          tone: state.agent_tone,
          bill_kind: state.analyzer.metadata.bill_kind,
          is_first_contact: false,
          user_name: state.analyzer.metadata.patient_name,
          preserve_facts: collectPreserveFacts(state.analyzer),
          anthropic,
        });
        const out: OutboundEmail = {
          to: state.provider_email,
          from: state.user_email,
          subject: humanized.subject,
          body_text: humanized.body,
          thread_id: state.thread_id,
          in_reply_to: lastInbound?.message_id,
          cc: state.cc,
        };
        const sent = await client.send(out);
        outboundSentAt = sent.sent_at ?? new Date().toISOString();
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Email sent. message_id=${sent.message_id}.`,
        });
        terminated = true;
      } else if (block.name === "mark_resolved") {
        // Agent ignored "do NOT mark_resolved" — let resolveOrGate handle
        // the budget. With push_back_count incremented this round, hitting
        // MAX_PUSH_BACK_ROUNDS forces escalation.
        const input = block.input as {
          resolution: ResolutionKind;
          final_amount_owed: number;
          notes: string;
          requires_signature?: boolean;
          signature_doc_summary?: string;
        };
        nextOutcome = resolveOrGate(draftState, input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Resolution recorded.",
        });
        terminated = true;
      } else if (block.name === "escalate_human") {
        const input = block.input as { reason: EscalationReason; notes: string };
        nextOutcome = { status: "escalated", reason: input.reason, notes: input.notes };
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Escalated." });
        terminated = true;
      }
    }
    messages.push({ role: "user", content: toolResults });
    if (terminated) break;
  }

  if (!terminated) {
    nextOutcome = {
      status: "escalated",
      reason: "unclear",
      notes: `Agent did not produce a terminal tool call within ${MAX_TURNS_PER_STEP} turns on push-back; escalating.`,
    };
  }

  return {
    ...state,
    user_directives: newDirectives,
    push_back_count: currentPushBacks + 1,
    outcome: nextOutcome,
    email_outbound_sent_at: outboundSentAt ?? state.email_outbound_sent_at,
    seq: (state.seq ?? 0) + 1,
  };
}

/**
 * Mark a co-pilot proposed resolution as accepted by the user. Promotes
 * `awaiting_user_review` → `resolved` with the same amounts, preserving any
 * signature record. Idempotent on repeated calls (already-resolved threads
 * pass through unchanged).
 */
export function acceptProposedResolution(state: NegotiationState): NegotiationState {
  if (state.outcome.status !== "awaiting_user_review") return state;
  const o = state.outcome;
  return {
    ...state,
    outcome: {
      status: "resolved",
      resolution: o.resolution,
      final_amount_owed: o.proposed_amount,
      notes: o.summary,
      requires_signature: o.requires_signature,
      signature_doc_summary: o.signature_doc_summary,
    },
    seq: (state.seq ?? 0) + 1,
  };
}

/**
 * Save/load NegotiationState. We keep this next to the thread file for easy
 * inspection: out/users/<user_id>/threads/{thread_id}.state.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { currentUserPaths } from "./lib/user-paths.ts";

function stateDir(): string {
  return currentUserPaths().threadsDir;
}

export function saveNegotiationState(state: NegotiationState, threadsDir?: string): void {
  const dir = threadsDir ?? stateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${state.thread_id}.state.json`), JSON.stringify(state, null, 2), "utf8");
}

export function loadNegotiationState(thread_id: string, threadsDir?: string): NegotiationState | null {
  const dir = threadsDir ?? stateDir();
  const path = join(dir, `${thread_id}.state.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as NegotiationState;
  // Migrate-on-read: pre-v0.1.36 threads have no agent_mode, seq, or
  // push_back_count. Default to autonomous (preserves prior behavior:
  // mark_resolved closed the thread immediately) and seed counters at 0.
  let dirty = false;
  if (raw.agent_mode === undefined) {
    raw.agent_mode = "autonomous";
    dirty = true;
  }
  if (raw.seq === undefined) {
    raw.seq = 0;
    dirty = true;
  }
  if (raw.push_back_count === undefined) {
    raw.push_back_count = 0;
    dirty = true;
  }
  if (dirty) saveNegotiationState(raw, threadsDir);
  return raw;
}

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
import { loadThread, saveThread, type ThreadState } from "./clients/email-mock.ts";
import { newId } from "./clients/email.ts";
import type { AgentTone, AgentMode } from "./lib/user-settings.ts";
import { toneGuidance } from "./lib/feedback-parser.ts";
import { humanize } from "./lib/humanizer.ts";
import {
  factCheck,
  violationsToFeedback,
} from "./skills/_harness/run-fact-check.ts";
import {
  classifyReply,
  classifyReplyAsPrior,
} from "./skills/_harness/run-classify-reply.ts";
import {
  adversarialReview,
  weakPointsToFeedback,
} from "./skills/_harness/run-adversarial-review.ts";
import { propagateToBrain } from "./skills/_harness/run-propagate-to-brain.ts";
import {
  SEND_EMAIL_TOOL,
  MARK_RESOLVED_TOOL,
  ESCALATE_HUMAN_TOOL,
} from "./skills/_harness/tools.ts";
import { loadSkill, renderSkill } from "./skills/_harness/skill-loader.ts";
import { providerKey, renderBrainContext } from "./brain/provider-brain.ts";
import type { ProviderRunners } from "./llm/provider.ts";

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

/**
 * Build the system prompt for a negotiation turn. The base prompt
 * lives in src/skills/draft-reply.md (one source of truth for prompt
 * iteration); this function fills the four substitution slots
 * conditionally and renders.
 *
 * brain_context_block is the compounding-loop closer — when the
 * provider has any cross-user playbook on file (Phase 4 writes it,
 * Phase 5a reads it back), it gets injected here so the agent knows
 * what's worked against this counterparty before. Empty string when
 * the brain is off, the provider is new, or the analyzer didn't
 * surface a provider name.
 */
function buildSystemPrompt(
  state: Pick<
    NegotiationState,
    "user_directives" | "agent_tone" | "agent_mode" | "push_back_count" | "analyzer"
  >,
): string {
  return renderSkill(loadSkill("draft-reply"), {
    tone_block: toneBlock(state.agent_tone),
    mode_block: modeBlock(state.agent_mode, state.push_back_count),
    directives_block: directivesBlock(state.user_directives),
    brain_context_block: brainContextBlock(state.analyzer.metadata.provider_name),
  });
}

function toneBlock(tone: NegotiationState["agent_tone"]): string {
  if (!tone) return "";
  return `\n\n## User-specified tone: ${tone}\n\n${toneGuidance(tone)}`;
}

function modeBlock(
  agentMode: AgentMode | undefined,
  pushBackCount: number | undefined,
): string {
  const mode: AgentMode = agentMode ?? "autonomous";
  if (mode === "copilot") {
    const remaining = Math.max(0, MAX_PUSH_BACK_ROUNDS - (pushBackCount ?? 0));
    return `\n\n## Mode: co-pilot\n\nMark resolved when the rep agrees to a final figure. The user will then accept the resolution or instruct you to push back; you do not close threads on your own. The user has ${remaining} push-back round${remaining === 1 ? "" : "s"} remaining.`;
  }
  return `\n\n## Mode: autonomous\n\nClose anything at or below the final_acceptable_floor without asking. The user has authorized you to settle on their behalf. Notify-on-resolution happens automatically; you do NOT need to "check in" before mark_resolved.`;
}

function directivesBlock(directives: string | undefined): string {
  const trimmed = directives?.trim();
  if (!trimmed) return "";
  return `\n\n## User directives (from the patient — must be honored)\n\n${trimmed}`;
}

/**
 * Render the cross-user provider playbook for this provider, or empty
 * string when there's nothing yet. Wrapped in a leading "\n\n" so the
 * skill template's tail-concatenation doesn't need conditionals.
 *
 * The brain table only fills up when someone has flipped BONSAI_BRAIN=1
 * AND BONSAI_BRAIN_HMAC_KEY is set — same gates that guard the write
 * path. When the table is empty (early adopters, new providers), this
 * is a single SQLite point lookup that returns null and we emit "".
 */
function brainContextBlock(providerName: string | null | undefined): string {
  if (!providerName) return "";
  const ctx = renderBrainContext(providerKey(providerName));
  if (!ctx) return "";
  return `\n\n${ctx}`;
}

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
  // Strict-equality on a boolean. The model can drift to string "true"
  // /"false" under length pressure; double-negation would treat "false"
  // (truthy string) as a signature gate. We only honor the literal
  // boolean true. The system prompt already says "when in doubt, set
  // true" — if the model emits a string we'd rather miss the gate than
  // gate on every "false" response forever.
  const requires_signature = input.requires_signature === true;
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
/**
 * Compact "floor=$X; original=$Y" context string used by the
 * cross-model classifier and adversarial reviewer. Both pass it as a
 * skill input so they can distinguish concession (at/below floor)
 * from partial concession (between floor and original).
 *
 * Bonsai-internal only — these LLM calls are server-side and the
 * dollar values are part of the customer's own bill, not cross-user
 * brain content. The provider-brain PII gate does not apply here.
 */
function floorContextString(state: NegotiationState): string {
  const original = state.analyzer.metadata.bill_current_balance_due;
  const eob = state.analyzer.metadata.eob_patient_responsibility;
  const parts = [`floor=$${state.final_acceptable_floor}`];
  if (original != null) parts.push(`original=$${original}`);
  if (eob != null) parts.push(`eob_amount=$${eob}`);
  return parts.join("; ");
}

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
  /** Inject mock LLM runners (anthropic / openai). Used by the
   * cross-modal fact-check pass. Production leaves undefined. */
  runners?: ProviderRunners;
  /** Owner of this thread. Used to HMAC-hash for cross-user provider
   * brain events. Optional — when absent, the brain write path is
   * skipped. CLI replays and unit tests typically omit it. */
  user_id?: string;
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

  // Phase 5b: cross-model classifier (gpt-5) gives the agent a structured
  // prior on what kind of reply this is. No-op when BONSAI_CROSSMODAL is
  // off; null on any error (fail-open). Injected as an extra block into
  // the user message — the agent treats it as a hint, not a directive.
  const latestInbound = inboundSinceLast[inboundSinceLast.length - 1];
  const lastOutbound = thread.outbound[thread.outbound.length - 1];
  const classification = await classifyReply({
    latest_inbound: latestInbound?.body_text ?? "",
    prior_outbound: lastOutbound?.body_text ?? "(no prior outbound)",
    bill_kind: state.analyzer.metadata.bill_kind ?? "other",
    floor_context: floorContextString(state),
    runners: opts.runners,
  });
  const classifierBlock = classifyReplyAsPrior(classification);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `${context}\n\n## Thread so far (newest inbound is the message to respond to)\n\n${rendered}${classifierBlock}\n\n## Your task\n\nDecide the next action. Call exactly one of: send_email, mark_resolved, escalate_human.`,
    },
  ];

  let newOutcome: NegotiationOutcome = { status: "in_progress" };
  let terminatedCleanly = false;
  let outboundSentAt: string | undefined;
  // Cross-modal eval budgets, each independent. Both failures inside a
  // single step can burn turns separately; MAX_TURNS_PER_STEP caps the
  // total at 4. Fail-open: when budgets exhaust, ship the draft and
  // log a cap_violation warning.
  let factCheckRetries = 0;
  let adversarialRetries = 0;
  const MAX_FACT_CHECK_RETRIES = 1;
  const MAX_ADVERSARIAL_RETRIES = 1;

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
        const preserveFacts = collectPreserveFacts(state.analyzer);
        // Cross-modal fact-check (gpt-5) BEFORE humanize. No-op when
        // BONSAI_CROSSMODAL is unset. On first failure we feed
        // violations back so Claude redrafts; on a repeat failure we
        // log and ship the draft anyway. Humanizer can't fix a
        // fabricated claim number — the redraft has to come from the
        // negotiation agent.
        const fc = await factCheck({
          draft_subject: input.subject,
          draft_body: input.body_text,
          preserve_facts: preserveFacts,
          runners: opts.runners,
        });
        if (!fc.passed && factCheckRetries < MAX_FACT_CHECK_RETRIES) {
          factCheckRetries++;
          console.warn(
            `[fact-check.retry] thread=${state.thread_id} violations=${fc.violations.length} — asking agent to redraft`,
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: violationsToFeedback(fc.violations),
            is_error: true,
          });
          // Don't set terminated — the next turn will redraft.
          continue;
        }
        if (!fc.passed) {
          console.warn(
            `[fact-check.cap_violation] thread=${state.thread_id} shipping draft after ${factCheckRetries} retry(s) with ${fc.violations.length} unresolved violations`,
          );
        }
        // Phase 6: adversarial-review (gpt-5). Plays the rep, finds
        // weak points the agent should fix before the email goes out.
        // Only HIGH-severity weak points trigger a redraft — we don't
        // burn the budget on minor issues the humanizer would handle.
        const adv = await adversarialReview({
          draft_subject: input.subject,
          draft_body: input.body_text,
          bill_kind: state.analyzer.metadata.bill_kind ?? "other",
          prior_outbound: lastOutbound?.body_text ?? "(no prior outbound)",
          latest_inbound: latestInbound?.body_text ?? "",
          floor_context: floorContextString(state),
          runners: opts.runners,
        });
        if (!adv.passed && adversarialRetries < MAX_ADVERSARIAL_RETRIES) {
          adversarialRetries++;
          console.warn(
            `[adversarial.retry] thread=${state.thread_id} weak_points=${adv.weak_points.length} — asking agent to redraft`,
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: weakPointsToFeedback(adv.weak_points),
            is_error: true,
          });
          continue;
        }
        if (!adv.passed) {
          console.warn(
            `[adversarial.cap_violation] thread=${state.thread_id} shipping draft after ${adversarialRetries} retry(s) with ${adv.weak_points.length} unresolved weak points`,
          );
        }
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
          preserve_facts: preserveFacts,
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
  // Fire-and-forget brain propagation when this step closed the thread.
  // The propagate runner has its own env gate (BONSAI_BRAIN=1) and
  // fail-open behavior — if anything errors, the thread closure is
  // unaffected. We await it (not truly fire-and-forget) so tests can
  // assert deterministically; in prod the cost is one extra Anthropic
  // call per closed thread.
  await maybePropagateBrain(state, nextState, thread, opts.user_id, opts.runners);
  return nextState;
}

/**
 * Fire propagate-to-brain when a step transitions a thread into a
 * terminal outcome (resolved or escalated). awaiting_user_review is
 * NOT terminal — the user may push back and the brain should record
 * the FINAL state, not a mid-flight one.
 *
 * Coverage gap (closed in Phase 5): co-pilot threads that the user
 * approves via acceptProposedResolution() also reach `resolved`, but
 * that path is sync today and not threaded through here. Phase 5's
 * harness routes every terminal transition through a single chokepoint
 * so brain propagation fires uniformly.
 */
async function maybePropagateBrain(
  prevState: NegotiationState,
  nextState: NegotiationState,
  thread: ThreadState,
  user_id: string | undefined,
  runners: ProviderRunners | undefined,
): Promise<void> {
  const status = nextState.outcome.status;
  if (status !== "resolved" && status !== "escalated") return;
  if (prevState.outcome.status === status) return; // already propagated on a prior step
  if (!user_id) return; // CLI replays / unit tests without owner: skip
  const provider = nextState.analyzer.metadata.provider_name;
  const billKind = nextState.analyzer.metadata.bill_kind;
  if (!provider) return;
  await propagateToBrain({
    provider_display_name: provider,
    bill_kind: billKind ?? "other",
    thread_summary: renderThreadForClaude(thread),
    final_outcome: renderFinalOutcome(nextState.outcome),
    thread_id: nextState.thread_id,
    user_id,
    runners,
  });
}

function renderFinalOutcome(outcome: NegotiationOutcome): string {
  if (outcome.status === "resolved") {
    return `RESOLVED — resolution=${outcome.resolution}; signature_required=${outcome.requires_signature ? "yes" : "no"}; notes: ${outcome.notes}`;
  }
  if (outcome.status === "escalated") {
    return `ESCALATED — reason=${outcome.reason}; notes: ${outcome.notes}`;
  }
  return `STATUS: ${outcome.status}`;
}

export interface UserPushBackOpts {
  state: NegotiationState;
  client: EmailClient;
  /** Free-text or structured-chip note from the user — appended to
   * user_directives so the next agent turn honors it. */
  note: string;
  anthropic?: Anthropic;
  threadsDir?: string;
  /** Inject mock LLM runners (anthropic / openai). Used by the
   * cross-modal fact-check pass. Production leaves undefined. */
  runners?: ProviderRunners;
  /** Owner of this thread. Used to HMAC-hash for cross-user provider
   * brain events. Optional. */
  user_id?: string;
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

  // Phase 5b: classifier prior on the rep's last reply (if any). On
  // a push-back step there's no NEW inbound, so we classify the most
  // recent inbound on the thread — that's the message the user is
  // pushing back about.
  const lastInboundPb = thread.inbound[thread.inbound.length - 1];
  const lastOutboundPb = thread.outbound[thread.outbound.length - 1];
  const classification = lastInboundPb
    ? await classifyReply({
        latest_inbound: lastInboundPb.body_text,
        prior_outbound: lastOutboundPb?.body_text ?? "(no prior outbound)",
        bill_kind: state.analyzer.metadata.bill_kind ?? "other",
        floor_context: floorContextString(state),
        runners: opts.runners,
      })
    : null;
  const classifierBlock = classifyReplyAsPrior(classification);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${context}\n\n## Thread so far\n\n${rendered}${classifierBlock}\n\n## User push-back\n\nThe user reviewed your previous proposed resolution and pushed back. Their note: "${trimmedNote || "(no specific guidance)"}".\n\nCompose the next outbound message that pushes back on the rep's last offer, incorporating the user's guidance. Call send_email with the next message; do NOT call mark_resolved on this turn (the user just rejected the prior resolution).`,
    },
  ];

  let outboundSentAt: string | undefined;
  let nextOutcome: NegotiationOutcome = { status: "in_progress" };
  let terminated = false;
  // Same fact-check + adversarial budgets as stepNegotiation: one retry
  // each, then ship with a logged warning.
  let factCheckRetries = 0;
  let adversarialRetries = 0;
  const MAX_FACT_CHECK_RETRIES = 1;
  const MAX_ADVERSARIAL_RETRIES = 1;

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
        const preserveFacts = collectPreserveFacts(state.analyzer);
        const fc = await factCheck({
          draft_subject: input.subject,
          draft_body: input.body_text,
          preserve_facts: preserveFacts,
          runners: opts.runners,
        });
        if (!fc.passed && factCheckRetries < MAX_FACT_CHECK_RETRIES) {
          factCheckRetries++;
          console.warn(
            `[fact-check.retry] thread=${state.thread_id} pushback violations=${fc.violations.length} — asking agent to redraft`,
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: violationsToFeedback(fc.violations),
            is_error: true,
          });
          continue;
        }
        if (!fc.passed) {
          console.warn(
            `[fact-check.cap_violation] thread=${state.thread_id} pushback shipping after ${factCheckRetries} retry(s) with ${fc.violations.length} unresolved violations`,
          );
        }
        // Phase 6: adversarial-review on the push-back path too. The
        // lastInboundPb / lastOutboundPb were captured at the top of
        // the function before the loop started.
        const adv = await adversarialReview({
          draft_subject: input.subject,
          draft_body: input.body_text,
          bill_kind: state.analyzer.metadata.bill_kind ?? "other",
          prior_outbound: lastOutboundPb?.body_text ?? "(no prior outbound)",
          latest_inbound: lastInboundPb?.body_text ?? "",
          floor_context: floorContextString(state),
          runners: opts.runners,
        });
        if (!adv.passed && adversarialRetries < MAX_ADVERSARIAL_RETRIES) {
          adversarialRetries++;
          console.warn(
            `[adversarial.retry] thread=${state.thread_id} pushback weak_points=${adv.weak_points.length} — asking agent to redraft`,
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: weakPointsToFeedback(adv.weak_points),
            is_error: true,
          });
          continue;
        }
        if (!adv.passed) {
          console.warn(
            `[adversarial.cap_violation] thread=${state.thread_id} pushback shipping after ${adversarialRetries} retry(s) with ${adv.weak_points.length} unresolved weak points`,
          );
        }
        const humanized = await humanize({
          body: input.body_text,
          subject: input.subject,
          tone: state.agent_tone,
          bill_kind: state.analyzer.metadata.bill_kind,
          is_first_contact: false,
          user_name: state.analyzer.metadata.patient_name,
          preserve_facts: preserveFacts,
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

  const nextState: NegotiationState = {
    ...state,
    user_directives: newDirectives,
    push_back_count: currentPushBacks + 1,
    outcome: nextOutcome,
    email_outbound_sent_at: outboundSentAt ?? state.email_outbound_sent_at,
    seq: (state.seq ?? 0) + 1,
  };
  await maybePropagateBrain(state, nextState, thread, opts.user_id, opts.runners);
  return nextState;
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

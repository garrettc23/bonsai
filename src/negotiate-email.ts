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
import type { AgentTone } from "./lib/user-settings.ts";
import { toneGuidance } from "./lib/feedback-parser.ts";
import { humanize } from "./lib/humanizer.ts";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 2048;
const MAX_TURNS_PER_STEP = 4;

export type NegotiationOutcome =
  | { status: "in_progress" }
  | { status: "resolved"; resolution: "full_adjustment" | "reduced" | "no_adjustment"; final_amount_owed: number; notes: string }
  | { status: "escalated"; reason: "hostile" | "legal" | "unclear" | "deadlock"; notes: string };

export interface NegotiationState {
  thread_id: string;
  analyzer: AnalyzerResult;
  user_email: string;
  provider_email: string;
  /** Lowest final amount the patient is willing to pay for this claim. */
  final_acceptable_floor: number;
  /** History of message ids seen, to drive loop termination. */
  last_seen_inbound_ts: string;
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
}

function buildSystemPrompt(state: Pick<NegotiationState, "user_directives" | "agent_tone">): string {
  const parts: string[] = [SYSTEM_PROMPT];
  if (state.agent_tone) {
    parts.push(
      `\n\n## User-specified tone: ${state.agent_tone}\n\n${toneGuidance(state.agent_tone)}`,
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
- Body: 1–3 short paragraphs by default. Only go longer if the situation genuinely demands it (multi-finding medical dispute, complex back-and-forth). Cut anything not load-bearing.
- Don't open with "I hope this email finds you well", "I am writing to formally", or other AI-isms — the humanizer will strip them, but skipping them yourself saves a hop.
- Reference the original appeal letter ("as documented in my initial dispute") rather than re-attaching the whole findings list on follow-ups.`;

const SEND_EMAIL_TOOL: Anthropic.Tool = {
  name: "send_email",
  description:
    "Draft and send the next outbound email in the negotiation thread. This sends the message immediately; do not compose a draft and then call this as a preview.",
  input_schema: {
    type: "object",
    required: ["subject", "body_markdown"],
    properties: {
      subject: {
        type: "string",
        minLength: 3,
        description: "Subject line. For replies, preserve the original subject with 'Re: ' prefix.",
      },
      body_markdown: {
        type: "string",
        minLength: 50,
        description:
          "Full email body in markdown. Include greeting, 3–6 short paragraphs, and a signature block.",
      },
    },
  },
};

const MARK_RESOLVED_TOOL: Anthropic.Tool = {
  name: "mark_resolved",
  description:
    "Call when the billing department has agreed to correct the account or reduce the balance to an acceptable amount. Terminates the negotiation.",
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
      reason: { type: "string", enum: ["hostile", "legal", "unclear", "deadlock"] },
      notes: { type: "string", minLength: 10 },
    },
  },
};

function renderThreadForClaude(thread: { outbound: SentEmail[]; inbound: InboundEmail[] }): string {
  const items: Array<{ ts: string; role: "us" | "them"; body: string; subject: string }> = [];
  for (const m of thread.outbound) {
    items.push({ ts: m.sent_at, role: "us", subject: m.subject, body: m.body_markdown });
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
  /** Compact summary of prior negotiation attempts on other channels.
   * Stored on state so every step's analyzer context includes it. */
  prior_attempts_summary?: string;
  /** CC recipients (typically the user's email) copied on every outbound.
   * Persisted on NegotiationState so follow-ups reuse the list. */
  cc?: string[];
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
    body_markdown: humanized.body,
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
    outcome: { status: "in_progress" },
    user_directives: opts.user_directives,
    agent_tone: opts.agent_tone,
    prior_attempts_summary: opts.prior_attempts_summary,
    cc: opts.cc,
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
        const input = block.input as { subject: string; body_markdown: string };
        const lastInbound = inboundSinceLast[inboundSinceLast.length - 1];
        // Humanizer pass on every follow-up. Same contract as the initial
        // letter — preserves grounded facts, applies tone + playbook, strips
        // AI-isms. is_first_contact: false so the humanizer doesn't open
        // with introductions.
        const humanized = await humanize({
          body: input.body_markdown,
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
          body_markdown: humanized.body,
          thread_id: state.thread_id,
          in_reply_to: lastInbound?.message_id,
          cc: state.cc,
        };
        const sent = await client.send(out);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Email sent. message_id=${sent.message_id}. Waiting on their reply. Do not send another message until they respond.`,
        });
        terminated = true;
      } else if (block.name === "mark_resolved") {
        const input = block.input as {
          resolution: "full_adjustment" | "reduced" | "no_adjustment";
          final_amount_owed: number;
          notes: string;
        };
        newOutcome = {
          status: "resolved",
          resolution: input.resolution,
          final_amount_owed: input.final_amount_owed,
          notes: input.notes,
        };
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Resolution recorded." });
        terminated = true;
      } else if (block.name === "escalate_human") {
        const input = block.input as { reason: "hostile" | "legal" | "unclear" | "deadlock"; notes: string };
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
    outcome: newOutcome,
  };
  return nextState;
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
  return JSON.parse(readFileSync(path, "utf8"));
}

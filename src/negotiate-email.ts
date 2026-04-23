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
import type { AnalyzerResult } from "./types.ts";
import { generateAppealLetter } from "./appeal-letter.ts";
import { loadThread, saveThread } from "./clients/email-mock.ts";
import { newId } from "./clients/email.ts";

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 2048;
const MAX_TURNS_PER_STEP = 4;

export type NegotiationOutcome =
  | { status: "in_progress" }
  | { status: "resolved"; resolution: "full_adjustment" | "reduced" | "no_adjustment"; final_amount_owed: number; notes: string }
  | { status: "escalated"; reason: "hostile" | "legal" | "unclear" | "deadlock"; notes: string };

export interface NegotiationState {
  thread_id: string;
  analyzer: AnalyzerResult;
  patient_email: string;
  provider_email: string;
  /** Lowest final amount the patient is willing to pay for this claim. */
  final_acceptable_floor: number;
  /** History of message ids seen, to drive loop termination. */
  last_seen_inbound_ts: string;
  outcome: NegotiationOutcome;
}

const SYSTEM_PROMPT = `You are Bonsai, a medical-billing negotiator acting on behalf of a patient. You exchange email with a hospital billing department over multiple rounds. Your single goal: reduce the patient's balance due to no more than the EOB-stated patient responsibility, plus legitimately un-disputed charges.

## Ground rules (strict)

1. Only quote facts from the analyzer's findings. Every dollar figure and every line_quote in your reply must come from the analyzer result you were given in the opening user message. Do not invent CPT codes, dates, or amounts.
2. Be formal, factual, firm, and polite. Never hostile. Never accusatory. You write like a consumer-rights attorney: short paragraphs, clean structure, legal citations when relevant (No Surprises Act; FCRA/CFPB for credit reporting).
3. If a reply concedes to the EOB patient responsibility or lower, call mark_resolved with resolution=full_adjustment.
4. If a reply offers a reduced amount between the EOB responsibility and the current balance, accept ONLY IF the offer is at or below the final_acceptable_floor; call mark_resolved with resolution=reduced.
5. If a reply denies the dispute outright, cite the EOB again, restate the No Surprises Act framing, and send a follow-up. After 3 denials, escalate_human with reason=deadlock.
6. If a reply is hostile, contains legal threats, or references collections/attorneys, escalate_human immediately.
7. If a reply is ambiguous or asks for info you don't have (e.g. prior payments), escalate_human with reason=unclear.

## Tool-use order

You will be called once per turn. On each turn you MUST do exactly one of:
- Call send_email with the next outbound message.
- Call mark_resolved.
- Call escalate_human.

Do NOT emit prose; the tool call is your entire output.

## Email style

- Subject line for replies: keep the original subject, prepend "Re: " if the reply doesn't already have it.
- Opening: reference claim number + account number + DOS.
- Body: 3–6 short paragraphs. Lead with what you want. Cite the EOB page and amount. Cite statute when relevant. Close with a specific ask + a 14-day response deadline.
- Closing: sign as the patient's name from the metadata.
- Never attach a long "findings list" on replies — they already have the initial letter. Reference it with "as documented in our initial appeal dated [date]".`;

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

function renderAnalyzerContext(result: AnalyzerResult, floor: number): string {
  const high = result.errors.filter((e) => e.confidence === "high");
  const byType: Record<string, number> = {};
  for (const e of high) byType[e.error_type] = (byType[e.error_type] ?? 0) + e.dollar_impact;

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
`;
}

export interface StartOpts {
  analyzer: AnalyzerResult;
  client: EmailClient;
  patient_email: string;
  provider_email: string;
  final_acceptable_floor?: number; // defaults to eob patient responsibility
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
  const { analyzer, client, patient_email, provider_email } = opts;
  const floor = opts.final_acceptable_floor ?? analyzer.metadata.eob_patient_responsibility ?? 0;
  const thread_id = newId("thread");
  const letter = generateAppealLetter(analyzer);

  const msg: OutboundEmail = {
    to: provider_email,
    from: patient_email,
    subject: letter.subject,
    body_markdown: letter.markdown,
    thread_id,
  };
  const sent = await client.send(msg);

  const state: NegotiationState = {
    thread_id,
    analyzer,
    patient_email,
    provider_email,
    final_acceptable_floor: floor,
    last_seen_inbound_ts: new Date(0).toISOString(),
    outcome: { status: "in_progress" },
  };
  return { thread_id, sent, state };
}

export interface StepOpts {
  state: NegotiationState;
  client: EmailClient;
  anthropic?: Anthropic;
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

  const thread = loadThread(state.thread_id);
  const inboundSinceLast = thread.inbound.filter(
    (m) => Date.parse(m.received_at) > Date.parse(state.last_seen_inbound_ts),
  );
  if (inboundSinceLast.length === 0) return state; // nothing to do

  const context = renderAnalyzerContext(state.analyzer, state.final_acceptable_floor);
  const rendered = renderThreadForClaude(thread);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `${context}\n\n## Thread so far (newest inbound is the message to respond to)\n\n${rendered}\n\n## Your task\n\nDecide the next action. Call exactly one of: send_email, mark_resolved, escalate_human.`,
    },
  ];

  let newOutcome: NegotiationOutcome = { status: "in_progress" };

  for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
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
        const out: OutboundEmail = {
          to: state.provider_email,
          from: state.patient_email,
          subject: input.subject,
          body_markdown: input.body_markdown,
          thread_id: state.thread_id,
          in_reply_to: lastInbound?.message_id,
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
    if (terminated) break;
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
 * inspection: out/threads/{thread_id}.state.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "out", "threads");

export function saveNegotiationState(state: NegotiationState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${state.thread_id}.state.json`), JSON.stringify(state, null, 2), "utf8");
}

export function loadNegotiationState(thread_id: string): NegotiationState | null {
  const path = join(STATE_DIR, `${thread_id}.state.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

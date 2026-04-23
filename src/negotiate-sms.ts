/**
 * SMS negotiation loop.
 *
 * Parallel to negotiate-email.ts but for text message exchanges. Some
 * providers (Klara, Luma Health, OhMD) run patient billing over SMS now;
 * this module drives that flow.
 *
 * Differences from email:
 *   - No subject line.
 *   - Body cap ~640 chars (4 SMS segments). System prompt enforces.
 *   - More conversational, fewer legal citations, still grounded.
 *   - Extra tool: `escalate_to_voice` — if the rep says "call the billing line"
 *     twice OR if the dispute hits a dead end in < 2 rounds, we hand off to
 *     the voice agent rather than continuing to text.
 *
 * Claude tools:
 *   - send_sms: draft + send the next outbound message
 *   - mark_resolved: outcome = full_adjustment | reduced | no_adjustment
 *   - escalate_human: reason = hostile | legal | unclear | deadlock
 *   - escalate_to_voice: reason = rep_requested | dispute_too_complex
 *
 * Like email, Claude cannot promise settlement above the final_acceptable_floor.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SmsClient, OutboundSms, SentSms, InboundSms } from "./clients/sms.ts";
import type { AnalyzerResult } from "./types.ts";
import { loadSmsThread } from "./clients/sms-mock.ts";
import { newSmsId } from "./clients/sms.ts";

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 1024;
const MAX_TURNS_PER_STEP = 4;
const SMS_BODY_CAP = 640;

export type SmsNegotiationOutcome =
  | { status: "in_progress" }
  | { status: "resolved"; resolution: "full_adjustment" | "reduced" | "no_adjustment"; final_amount_owed: number; notes: string }
  | { status: "escalated"; reason: "hostile" | "legal" | "unclear" | "deadlock"; notes: string }
  | { status: "handed_off_to_voice"; reason: "rep_requested" | "dispute_too_complex"; notes: string };

export interface SmsNegotiationState {
  thread_id: string;
  analyzer: AnalyzerResult;
  patient_phone: string;
  provider_phone: string;
  final_acceptable_floor: number;
  last_seen_inbound_ts: string;
  outcome: SmsNegotiationOutcome;
}

const SYSTEM_PROMPT = `You are Bonsai, a medical-billing negotiator texting with a hospital billing department on behalf of a patient. Your goal: reduce the patient's balance to the EOB-stated patient responsibility, or as close as possible without exceeding final_acceptable_floor.

## Ground rules (strict)

1. Every dollar figure and every cited line comes from the analyzer output in your opening context. Do not invent CPT codes, amounts, dates, or provider names.
2. Tone: direct, polite, firm. You're texting a human — write like a person, not a lawyer. Short sentences. One ask per message.
3. SMS message cap: ${SMS_BODY_CAP} characters. Hard limit. Draft tight. No markdown, no bullets, no line breaks inside a sentence. Plain prose.
4. If a reply concedes to EOB patient responsibility or lower → mark_resolved (full_adjustment).
5. If a reply offers a reduction at or below final_acceptable_floor → mark_resolved (reduced).
6. If the rep tells you to "call the billing line" or "this can't be handled over text" TWICE, call escalate_to_voice with reason=rep_requested.
7. If the dispute involves balance billing over $1,500 AND the rep is resistant on turn 1, call escalate_to_voice with reason=dispute_too_complex. Voice converts better on NSA disputes.
8. If a reply is hostile, threatens collections, or references legal action → escalate_human (hostile or legal).
9. If the reply is ambiguous or asks for info you don't have → escalate_human (unclear).
10. After 3 outright denials with no movement → escalate_human (deadlock).

## Tool-use order

Exactly one tool call per turn:
- send_sms
- mark_resolved
- escalate_human
- escalate_to_voice

No prose output. The tool call is your entire response.

## SMS style

- Opening message: identify patient + claim number + the ONE top defensible finding with amount. Ask for confirmation of review timeline.
- Reply messages: reference specific numbers from the EOB. Do not re-send the full finding list.
- Never sign with a full letter signature — a first name + "— Bonsai on behalf of [patient]" is enough.
- Avoid legal jargon. Instead of "pursuant to the No Surprises Act", say "federal no-surprises-billing law requires". Shorter wins.`;

const SEND_SMS_TOOL: Anthropic.Tool = {
  name: "send_sms",
  description:
    "Draft and send the next outbound SMS in the negotiation thread. Body must be plain text under 640 characters. Do not include a subject line.",
  input_schema: {
    type: "object",
    required: ["body"],
    properties: {
      body: {
        type: "string",
        minLength: 20,
        maxLength: SMS_BODY_CAP,
        description: `Plain-text SMS body. Cap ${SMS_BODY_CAP} characters. One clear ask per message.`,
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
      },
      final_amount_owed: { type: "number", minimum: 0 },
      notes: { type: "string", minLength: 10 },
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

const ESCALATE_TO_VOICE_TOOL: Anthropic.Tool = {
  name: "escalate_to_voice",
  description:
    "Call when SMS is the wrong channel for this dispute. The orchestrator will hand off to the voice agent which uses the same analyzer findings.",
  input_schema: {
    type: "object",
    required: ["reason", "notes"],
    properties: {
      reason: { type: "string", enum: ["rep_requested", "dispute_too_complex"] },
      notes: { type: "string", minLength: 10 },
    },
  },
};

function renderThreadForClaude(thread: { outbound: SentSms[]; inbound: InboundSms[] }): string {
  const items: Array<{ ts: string; role: "us" | "them"; body: string }> = [];
  for (const m of thread.outbound) items.push({ ts: m.sent_at, role: "us", body: m.body });
  for (const m of thread.inbound) items.push({ ts: m.received_at, role: "them", body: m.body });
  items.sort((a, b) => a.ts.localeCompare(b.ts));
  if (items.length === 0) return "(thread empty — you have not sent the opening text yet)";
  return items
    .map(
      (it, i) =>
        `--- msg ${i + 1} (${it.role === "us" ? "OUTBOUND (you)" : "INBOUND (billing dept)"}) ts=${it.ts} ---\n${it.body}`,
    )
    .join("\n\n");
}

function renderAnalyzerContext(result: AnalyzerResult, floor: number): string {
  const high = result.errors.filter((e) => e.confidence === "high");
  return `## Dispute context (from grounded analyzer)

Patient: ${result.metadata.patient_name ?? "(unknown)"}
Provider: ${result.metadata.provider_name ?? "(unknown)"}
Claim #: ${result.metadata.claim_number ?? "(unknown)"}
DOS: ${result.metadata.date_of_service ?? "(unknown)"}
Insurer: ${result.metadata.insurer_name ?? "(unknown)"}

Bill balance due: $${result.metadata.bill_current_balance_due?.toFixed(2) ?? "?"}
EOB patient responsibility: $${result.metadata.eob_patient_responsibility?.toFixed(2) ?? "?"}
Defensible HIGH total: $${result.summary.high_confidence_total.toFixed(2)}

Final acceptable floor (do not settle above this): $${floor.toFixed(2)}

## HIGH-confidence findings

${high
  .map(
    (e, i) =>
      `${i + 1}. [${e.error_type}]${e.cpt_code ? ` CPT ${e.cpt_code}` : ""} $${e.dollar_impact.toFixed(2)}
   Quote: "${e.line_quote.trim()}"
   Why: ${e.evidence.trim()}`,
  )
  .join("\n")}
`;
}

export interface StartSmsOpts {
  analyzer: AnalyzerResult;
  client: SmsClient;
  patient_phone: string;
  provider_phone: string;
  final_acceptable_floor?: number;
  anthropic?: Anthropic;
}

export interface StartSmsResult {
  thread_id: string;
  sent: SentSms;
  state: SmsNegotiationState;
}

/**
 * Compose and send the opening SMS. Unlike email, the opening is NOT a templated
 * appeal letter — SMS needs punchier opener. We ask Claude to draft one in the
 * same send_sms shape the negotiation loop uses.
 */
export async function startSmsNegotiation(opts: StartSmsOpts): Promise<StartSmsResult> {
  const { analyzer, client, patient_phone, provider_phone } = opts;
  const floor = opts.final_acceptable_floor ?? analyzer.metadata.eob_patient_responsibility ?? 0;
  const thread_id = newSmsId("sms-thread");
  const anthropic = opts.anthropic ?? new Anthropic();

  const context = renderAnalyzerContext(analyzer, floor);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${context}\n\n## Your task\n\nYou are opening this SMS negotiation. Thread is empty. Send the opening text via send_sms. Identify the patient, claim, and ONE top defensible finding. Ask the billing rep to review within 7 days.`,
    },
  ];

  let opener: SentSms | null = null;
  for (let turn = 0; turn < 2; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [SEND_SMS_TOOL],
      tool_choice: { type: "tool", name: "send_sms" },
      messages,
    });
    const call = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "send_sms",
    );
    if (!call) {
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: "You must call send_sms to open the thread. Do it now.",
      });
      continue;
    }
    const input = call.input as { body: string };
    const out: OutboundSms = {
      to: provider_phone,
      from: patient_phone,
      body: input.body,
      thread_id,
    };
    opener = await client.send(out);
    break;
  }
  if (!opener) throw new Error("SMS negotiator failed to draft an opening message after 2 tries.");

  const state: SmsNegotiationState = {
    thread_id,
    analyzer,
    patient_phone,
    provider_phone,
    final_acceptable_floor: floor,
    last_seen_inbound_ts: new Date(0).toISOString(),
    outcome: { status: "in_progress" },
  };
  return { thread_id, sent: opener, state };
}

export interface StepSmsOpts {
  state: SmsNegotiationState;
  client: SmsClient;
  anthropic?: Anthropic;
}

/**
 * Advance the SMS negotiation one step. Reads new inbound, asks Claude to
 * pick a tool call, executes it, returns updated state.
 */
export async function stepSmsNegotiation(opts: StepSmsOpts): Promise<SmsNegotiationState> {
  const { state, client } = opts;
  const anthropic = opts.anthropic ?? new Anthropic();
  if (state.outcome.status !== "in_progress") return state;

  const thread = loadSmsThread(state.thread_id);
  const inboundSinceLast = thread.inbound.filter(
    (m) => Date.parse(m.received_at) > Date.parse(state.last_seen_inbound_ts),
  );
  if (inboundSinceLast.length === 0) return state;

  const context = renderAnalyzerContext(state.analyzer, state.final_acceptable_floor);
  const rendered = renderThreadForClaude(thread);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${context}\n\n## Thread so far (newest inbound is the message to respond to)\n\n${rendered}\n\n## Your task\n\nDecide the next action. Call exactly one of: send_sms, mark_resolved, escalate_human, escalate_to_voice.`,
    },
  ];

  let newOutcome: SmsNegotiationOutcome = { status: "in_progress" };

  for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [SEND_SMS_TOOL, MARK_RESOLVED_TOOL, ESCALATE_HUMAN_TOOL, ESCALATE_TO_VOICE_TOOL],
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
      if (block.name === "send_sms") {
        const input = block.input as { body: string };
        const lastInbound = inboundSinceLast[inboundSinceLast.length - 1];
        const out: OutboundSms = {
          to: state.provider_phone,
          from: state.patient_phone,
          body: input.body,
          thread_id: state.thread_id,
          in_reply_to: lastInbound?.message_id,
        };
        const sent = await client.send(out);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `SMS sent (message_id=${sent.message_id}, ${sent.segments} segment(s)). Waiting on their reply. Do not send another message until they respond.`,
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
      } else if (block.name === "escalate_to_voice") {
        const input = block.input as { reason: "rep_requested" | "dispute_too_complex"; notes: string };
        newOutcome = { status: "handed_off_to_voice", reason: input.reason, notes: input.notes };
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Handoff to voice recorded." });
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
  return { ...state, last_seen_inbound_ts: latestTs, outcome: newOutcome };
}

/** Persistence helpers mirror the email ones. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "out", "sms-threads");

export function saveSmsNegotiationState(state: SmsNegotiationState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    join(STATE_DIR, `${state.thread_id}.state.json`),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

export function loadSmsNegotiationState(thread_id: string): SmsNegotiationState | null {
  const path = join(STATE_DIR, `${thread_id}.state.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

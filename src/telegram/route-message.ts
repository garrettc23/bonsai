/**
 * Inbound Telegram routing brain.
 *
 * One Opus call per message. Claude sees:
 *   - the current state of the user's most recent bill (if any),
 *   - the user's text,
 * and picks one tool: send_reply, get_status, approve, stop,
 * ask_question, or update_plan. We execute the tool against the same HTTP
 * endpoints the web UI uses (loopback) so there's one code path for every
 * action — less drift, same behavior.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PENDING_DIR = join(ROOT, "out", "pending");

const PORT = Number.parseInt(process.env.PORT ?? "3333", 10);
const BASE = `http://127.0.0.1:${PORT}`;

interface PendingLite {
  run_id: string;
  fixture_name: string;
  status?: string;
  approved_at?: number;
  created_at?: number;
  partial_report?: {
    analyzer?: {
      metadata?: { provider_name?: string | null; patient_name?: string | null };
      errors?: Array<{ error_type: string; confidence: string; line_quote: string; dollar_impact: number; evidence?: string }>;
      summary?: { headline?: string };
    };
    summary?: {
      original_balance?: number;
      final_balance?: number;
      defensible_disputed?: number;
      patient_saved?: number;
      outcome?: string;
    };
    strategy?: { chosen?: string; reason?: string };
  };
  plan_edits?: string;
}

/** Load every PendingRun on disk, newest first. */
function loadAllPending(): PendingLite[] {
  if (!existsSync(PENDING_DIR)) return [];
  const rows: PendingLite[] = [];
  for (const file of readdirSync(PENDING_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const run = JSON.parse(readFileSync(join(PENDING_DIR, file), "utf-8")) as PendingLite;
      rows.push(run);
    } catch { /* skip */ }
  }
  rows.sort((a, b) => (b.approved_at ?? b.created_at ?? 0) - (a.approved_at ?? a.created_at ?? 0));
  return rows;
}

/** Pick the bill the user is most likely asking about right now. */
function pickActiveRun(): PendingLite | null {
  const all = loadAllPending();
  // Priority: in-flight negotiations > audited-not-yet-approved > most recent.
  const negotiating = all.find((r) => r.status === "negotiating");
  if (negotiating) return negotiating;
  const audited = all.find((r) => r.status === "audited" || r.status === undefined);
  if (audited) return audited;
  return all[0] ?? null;
}

function fmt$(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** Compact string describing the active bill, shown to the model as context. */
function summarizeActiveRun(run: PendingLite | null): string {
  if (!run) return "No active bills right now.";
  const meta = run.partial_report?.analyzer?.metadata ?? {};
  const summary = run.partial_report?.summary ?? {};
  const strategy = run.partial_report?.strategy ?? {};
  const errors = run.partial_report?.analyzer?.errors ?? [];
  const lines = [
    `Active bill: ${meta.provider_name ?? run.fixture_name} (run_id: ${run.run_id})`,
    `Status: ${run.status ?? "audited"}`,
    `Original balance: ${fmt$(summary.original_balance)} · Defensible disputable: ${fmt$(summary.defensible_disputed)} · Saved so far: ${fmt$(summary.patient_saved)}`,
    `Plan: ${strategy.chosen ?? "—"} — ${strategy.reason ?? "—"}`,
    `Findings (${errors.length}): ${errors.slice(0, 5).map((e) => `[${e.confidence}/${e.error_type} $${e.dollar_impact}]`).join(", ")}`,
  ];
  return lines.join("\n");
}

/* ─── Tool executors: loopback to the same HTTP API the web UI hits ──── */

async function execApprove(runId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId }),
  });
  if (!res.ok) throw new Error(await res.text());
  await res.json();
  return "Approved. Kicking off the negotiation now — I'll text you when the provider responds or when it's resolved.";
}

async function execStop(runId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return "Stopped. The agent won't take any further action on this bill.";
}

async function execAsk(runId: string, question: string): Promise<string> {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, question }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { answer: string };
  return data.answer;
}

async function execUpdatePlan(runId: string, message: string): Promise<string> {
  const res = await fetch(`${BASE}/api/plan-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, message }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { reply: string; strategy?: { chosen: string } };
  const chosen = data.strategy?.chosen;
  return chosen ? `${data.reply} (Channel is now "${chosen}".)` : data.reply;
}

/* ─── Brain ─────────────────────────────────────────────────────────── */

const ROUTE_TOOLS: Anthropic.Tool[] = [
  {
    name: "send_reply",
    description: "Reply to the user directly without taking any action. Use for greetings, small talk, clarifying questions, or answers you can produce from the provided state alone.",
    input_schema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", description: "The text to send to the user." } },
    },
  },
  {
    name: "get_status",
    description: "Send the user a concise summary of the active bill's status (provider, findings, defensible total, current plan, negotiation state).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "approve",
    description: "Kick off negotiation on the active bill. Use when the user says 'approve', 'go', 'send it', 'yes do it'.",
    input_schema: {
      type: "object",
      required: ["run_id"],
      properties: { run_id: { type: "string" } },
    },
  },
  {
    name: "stop",
    description: "Halt the agent on the active bill. Use when the user says 'stop', 'hold', 'wait', 'pause', 'cancel'.",
    input_schema: {
      type: "object",
      required: ["run_id"],
      properties: { run_id: { type: "string" } },
    },
  },
  {
    name: "ask_question",
    description: "Answer a question about the audit findings (what are the biggest errors, why is X flagged, what's the EOB say, etc). Forwards to the audit Q&A endpoint.",
    input_schema: {
      type: "object",
      required: ["run_id", "question"],
      properties: {
        run_id: { type: "string" },
        question: { type: "string", description: "The user's original question, verbatim." },
      },
    },
  },
  {
    name: "update_plan",
    description: "Change the negotiation plan (channel, floor, order). Use when the user says things like 'skip voice', 'email only', 'floor is $400'.",
    input_schema: {
      type: "object",
      required: ["run_id", "message"],
      properties: {
        run_id: { type: "string" },
        message: { type: "string", description: "The user's plan-change request, verbatim." },
      },
    },
  },
];

export async function routeInboundMessage(opts: {
  chatId: number;
  fromFirstName: string | null;
  text: string;
}): Promise<string | null> {
  const run = pickActiveRun();
  const stateSummary = summarizeActiveRun(run);

  const system = [
    "You are Bonsai, an agent that audits and negotiates bills for the user.",
    "You're talking to the user over SMS-like chat. Keep every reply short — 1-3 sentences.",
    "Never make up facts. If you don't have enough state to answer, call get_status or ask the user a clarifying question via send_reply.",
    "Always pick exactly one tool. Do not emit prose outside of a tool call.",
    "If the user references 'the bill' or doesn't name one, assume they mean the active bill below.",
    "",
    "CURRENT STATE:",
    stateSummary,
  ].join("\n");

  const anthropic = new Anthropic();
  const resp = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 400,
    system,
    tools: ROUTE_TOOLS,
    tool_choice: { type: "any" },
    messages: [
      { role: "user", content: opts.text },
    ],
  });

  const toolUse = resp.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    // Fallback — Claude returned text without a tool call. Pass it through.
    const text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text || null;
  }

  try {
    switch (toolUse.name) {
      case "send_reply":
        return (toolUse.input as { text: string }).text;
      case "get_status":
        return run ? formatStatusReply(run) : "No active bills yet. Upload a bill at the dashboard to get started.";
      case "approve": {
        const { run_id } = toolUse.input as { run_id: string };
        return await execApprove(run_id);
      }
      case "stop": {
        const { run_id } = toolUse.input as { run_id: string };
        return await execStop(run_id);
      }
      case "ask_question": {
        const { run_id, question } = toolUse.input as { run_id: string; question: string };
        return await execAsk(run_id, question);
      }
      case "update_plan": {
        const { run_id, message } = toolUse.input as { run_id: string; message: string };
        return await execUpdatePlan(run_id, message);
      }
      default:
        return "I'm not sure what to do with that. Try: 'status', 'approve', 'stop', or ask me a question about the bill.";
    }
  } catch (err) {
    console.error("[telegram] tool error", err);
    return `Sorry, that action failed: ${(err as Error)?.message ?? err}`;
  }
}

function formatStatusReply(run: PendingLite): string {
  const meta = run.partial_report?.analyzer?.metadata ?? {};
  const summary = run.partial_report?.summary ?? {};
  const strategy = run.partial_report?.strategy ?? {};
  const errors = run.partial_report?.analyzer?.errors ?? [];
  const high = errors.filter((e) => e.confidence === "high").length;
  const lines: string[] = [];
  lines.push(`${meta.provider_name ?? run.fixture_name} — ${labelForStatus(run.status)}`);
  if (summary.defensible_disputed) {
    lines.push(`${high} defensible overcharge${high === 1 ? "" : "s"}, ${fmt$(summary.defensible_disputed)} disputable of ${fmt$(summary.original_balance)}.`);
  }
  lines.push(`Plan: ${strategy.chosen ?? "—"}.`);
  if (run.status === "audited") {
    lines.push(`Reply APPROVE to start or ASK anything about the findings.`);
  } else if (run.status === "negotiating") {
    lines.push(`Reply STOP to halt the agent.`);
  }
  return lines.join("\n");
}

function labelForStatus(s?: string): string {
  switch (s) {
    case "negotiating": return "negotiating now";
    case "completed": return "resolved";
    case "cancelled": return "stopped";
    case "failed": return "failed — needs a human";
    default: return "audited, waiting on you";
  }
}

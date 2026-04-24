/**
 * Outbound Telegram notifications triggered by the server at lifecycle
 * events. Every function is a silent no-op if TELEGRAM_BOT_TOKEN or
 * TELEGRAM_CHAT_ID is unset — safe to call unconditionally from the
 * audit/approve/negotiate paths.
 */
import { sendMessage, telegramEnabled } from "./client.ts";
import { getTelegramConfig } from "../lib/user-settings.ts";
import type { BonsaiReport } from "../orchestrator.ts";

function chatId(): number | null {
  const raw = getTelegramConfig().chatId;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function ready(): number | null {
  if (!telegramEnabled()) return null;
  return chatId();
}

function fmt$(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** Audit just finished. Summarize findings and ask for approval. */
export async function notifyAuditComplete(opts: {
  provider: string;
  report: BonsaiReport;
  run_id: string;
}): Promise<void> {
  const cid = ready();
  if (cid == null) return;
  const errors = opts.report.analyzer?.errors ?? [];
  const high = errors.filter((e) => e.confidence === "high").length;
  const defensible = opts.report.summary?.defensible_disputed ?? 0;
  const original = opts.report.summary?.original_balance ?? 0;
  const channel = opts.report.strategy?.chosen ?? "persistent";
  const text = [
    `🌱 Bonsai audited your ${opts.provider} bill.`,
    `${high} defensible overcharge${high === 1 ? "" : "s"}, ${fmt$(defensible)} disputable of ${fmt$(original)}.`,
    `Plan: ${channel}.`,
    "",
    `Reply APPROVE to start, STOP to cancel, or ask me anything about the findings.`,
  ].join("\n");
  await sendMessage(cid, text);
}

/** Negotiation done. Hero line + savings. */
export async function notifyNegotiationDone(opts: {
  provider: string;
  report: BonsaiReport;
}): Promise<void> {
  const cid = ready();
  if (cid == null) return;
  const saved = opts.report.summary?.patient_saved ?? 0;
  const outcome = opts.report.summary?.outcome ?? "resolved";
  const final = opts.report.summary?.final_balance;
  if (outcome === "resolved" && saved > 0) {
    await sendMessage(cid, `✅ ${opts.provider}: settled. Saved you ${fmt$(saved)}${final != null ? ` — new balance ${fmt$(final)}` : ""}.`);
  } else if (outcome === "escalated") {
    await sendMessage(cid, `⚠️ ${opts.provider}: I couldn't close it on my own. Open the dashboard when you have a minute — I'll walk you through what's left.`);
  } else {
    await sendMessage(cid, `${opts.provider}: negotiation done. Check the dashboard for the summary.`);
  }
}

/** Background worker blew up. */
export async function notifyNegotiationFailed(opts: {
  provider: string;
  error: string;
}): Promise<void> {
  const cid = ready();
  if (cid == null) return;
  await sendMessage(cid, `⚠️ ${opts.provider}: negotiation failed — ${opts.error.slice(0, 160)}.`);
}

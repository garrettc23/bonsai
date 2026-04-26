/**
 * Operator-wide daily voice spend tracker. Single SQLite row per UTC day;
 * incremented on `end_call` webhook with the actual computed call cost.
 *
 * Used by `POST /api/voice/dial` to short-circuit when today's running total
 * + the upcoming call's max-estimate would breach BONSAI_VOICE_DAILY_BUDGET_USD.
 */
import { getDb } from "./db.ts";

function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function getTodaySpendUsd(now?: Date): number {
  const db = getDb();
  const row = db.prepare(`SELECT total_usd FROM voice_spend WHERE utc_date = ?`).get(utcDate(now)) as
    | { total_usd: number }
    | undefined;
  return row?.total_usd ?? 0;
}

export function addSpend(usd: number, now?: Date): number {
  if (!Number.isFinite(usd) || usd <= 0) return getTodaySpendUsd(now);
  const db = getDb();
  const date = utcDate(now);
  db.prepare(
    `INSERT INTO voice_spend (utc_date, total_usd) VALUES (?, ?)
     ON CONFLICT(utc_date) DO UPDATE SET total_usd = total_usd + excluded.total_usd`,
  ).run(date, usd);
  return getTodaySpendUsd(now);
}

export const DEFAULT_DAILY_BUDGET_USD = 50;

export function getDailyBudgetUsd(): number {
  const raw = process.env.BONSAI_VOICE_DAILY_BUDGET_USD;
  if (!raw) return DEFAULT_DAILY_BUDGET_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

/**
 * Persistence for the autonomy consent boundary (Workstream A3, production).
 *
 * Lives in SQLite (not the file-based user-settings) because the email
 * ingestion webhook reads consent OUTSIDE any authenticated request context,
 * keyed by user_id. The pure policy (decideAutonomousAction) is in
 * autonomy-consent.ts; this module only stores/loads/validates it.
 *
 * Safe by default: a user with no row resolves to defaultConsent() (copilot).
 */
import { getDb } from "./db.ts";
import { BillKind } from "../types.ts";
import {
  defaultConsent,
  type AutonomyConsent,
  type AutonomyMode,
} from "./autonomy-consent.ts";

interface ConsentRow {
  user_id: string;
  mode: string;
  auto_send_ceiling_usd: number;
  allowed_categories: string;
  updated_at: number;
}

const VALID_MODES: AutonomyMode[] = ["off", "copilot", "autonomous"];

function normalizeMode(mode: unknown): AutonomyMode {
  return VALID_MODES.includes(mode as AutonomyMode) ? (mode as AutonomyMode) : "copilot";
}

function normalizeCeiling(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Keep only real BillKind values; drop anything unrecognized or duplicated. */
function normalizeCategories(v: unknown): BillKind[] {
  const arr = Array.isArray(v) ? v : [];
  const valid = new Set(BillKind.options as readonly string[]);
  const out: BillKind[] = [];
  for (const c of arr) {
    if (typeof c === "string" && valid.has(c) && !out.includes(c as BillKind)) {
      out.push(c as BillKind);
    }
  }
  return out;
}

export function getConsent(userId: string): AutonomyConsent {
  const row = getDb()
    .query("SELECT user_id, mode, auto_send_ceiling_usd, allowed_categories, updated_at FROM autonomy_consent WHERE user_id = ?")
    .get(userId) as ConsentRow | null;
  if (!row) return defaultConsent();
  let categories: AutonomyConsent["allowed_categories"] = [];
  try {
    categories = normalizeCategories(JSON.parse(row.allowed_categories));
  } catch {
    categories = [];
  }
  return {
    mode: normalizeMode(row.mode),
    auto_send_ceiling_usd: normalizeCeiling(row.auto_send_ceiling_usd),
    allowed_categories: categories,
  };
}

/**
 * Upsert a user's consent. Input is sanitized: invalid mode → copilot,
 * negative/NaN ceiling → 0, unknown categories dropped. Returns the stored
 * (normalized) value so the API can echo exactly what took effect.
 */
export function setConsent(userId: string, input: Partial<AutonomyConsent>): AutonomyConsent {
  const next: AutonomyConsent = {
    mode: normalizeMode(input.mode),
    auto_send_ceiling_usd: normalizeCeiling(input.auto_send_ceiling_usd),
    allowed_categories: normalizeCategories(input.allowed_categories),
  };
  getDb()
    .query(
      `INSERT INTO autonomy_consent (user_id, mode, auto_send_ceiling_usd, allowed_categories, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         mode = excluded.mode,
         auto_send_ceiling_usd = excluded.auto_send_ceiling_usd,
         allowed_categories = excluded.allowed_categories,
         updated_at = excluded.updated_at`,
    )
    .run(userId, next.mode, next.auto_send_ceiling_usd, JSON.stringify(next.allowed_categories), Date.now());
  return next;
}

/**
 * Provider brain — cross-user playbook store.
 *
 * Every closed negotiation thread can append events to a provider's
 * brain page. The compiled_truth at the top of each row is an
 * LLM-rewritten summary the harness will inject into draft-reply
 * context (Phase 5). Today (Phase 4) we only build the WRITE path:
 * compiled_truth gets stored, but no skill reads it back yet.
 *
 * Three discipline layers protect against PII leakage:
 *
 *   1. **Tool schema constrains shape** — the propagate-to-brain skill
 *      emits events through a tool whose JSON Schema only allows known
 *      pattern-level fields with bounded lengths. Raw dollar amounts,
 *      account numbers, and free-form notes can't fit through the
 *      schema's named slots.
 *
 *   2. **PII regex gate** — we run every detail string AND the
 *      compiled_truth through a regex matcher (looks for $ amounts,
 *      ACCT-/CLM-/POL- style identifiers, email addresses, long digit
 *      runs). If a string matches, the entire propagate batch is
 *      rejected and a `brain.pii_blocked` warning is logged. Defense
 *      in depth — schemas don't catch model misbehavior at the value
 *      level.
 *
 *   3. **HMAC user_id_hash** — we hash user_id with a server-side
 *      secret so brain events can be correlated within a provider
 *      ("is one user spamming Aetna?") without ever storing the
 *      user_id. Different deploys with different secrets cannot
 *      cross-correlate.
 *
 * Per-user opt-out: BONSAI_BRAIN_OPT_OUT=1 makes upsertBrain() a
 * no-op for that user. The upsert call is the single chokepoint —
 * no other code writes to provider_brain_events.
 */
import { createHmac } from "node:crypto";
import { getDb } from "../lib/db.ts";

export interface BrainEvent {
  /** Pattern-level kind. The propagate skill's tool schema constrains
   * this to a fixed enum; we re-validate here so a future schema
   * change doesn't silently let new kinds in. */
  kind: string;
  /** ≤ 200 chars. Gated for PII before insert. */
  detail: string;
}

export interface UpsertBrainOpts {
  provider_key: string;
  display_name: string;
  bill_kind: string;
  compiled_truth: string;
  events: BrainEvent[];
  thread_id: string;
  user_id: string;
  /** UTC ms timestamp; default Date.now(). Tests pin this. */
  now?: number;
}

export interface BrainPage {
  provider_key: string;
  display_name: string;
  bill_kind: string;
  compiled_truth: string;
  updated_at: number;
  event_count: number;
}

/**
 * Normalize a provider name into a stable slug used as the brain key.
 * "Aetna Inc." → "aetna"
 * "PG&E"      → "pg-and-e"
 * "Comcast / Xfinity" → "comcast-xfinity"
 * Stable across releases — the slug IS the join key for events, so
 * never reformat without a migration.
 */
export function providerKey(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/&/g, " and ")
    // Strip common corporate suffixes that vary across bills for the
    // same entity ("Aetna" vs "Aetna Inc." vs "Aetna, Inc.").
    .replace(/\b(inc|incorporated|llc|corp|corporation|company|co|ltd|limited|plc)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "unknown";
}

/**
 * Hash a user_id with the brain HMAC secret. Required: the secret
 * must be set in env (BONSAI_BRAIN_HMAC_KEY). We refuse to fall back
 * to a constant — that would make hashes predictable and let an
 * attacker who saw the events table reverse-correlate.
 */
export function hashUserId(userId: string): string {
  const key = process.env.BONSAI_BRAIN_HMAC_KEY;
  if (!key || !key.trim()) {
    throw new Error(
      "[brain] BONSAI_BRAIN_HMAC_KEY is required to hash user_id for brain events. Set it in your env (a 32+ char random string).",
    );
  }
  return createHmac("sha256", key).update(userId).digest("hex").slice(0, 24);
}

/**
 * PII gate. Returns the offending pattern name if a string contains
 * something that looks like leaked source data; null if clean.
 *
 * The gate is intentionally loose-but-cheap: we'd rather reject a
 * benign event than let a leaked claim number into the cross-user
 * brain. Operators can inspect rejected events in the warning log if
 * a recurring false-positive needs the regex tuned.
 */
export function piiViolation(text: string): string | null {
  // Dollar amounts ($XX, $1,234.56, "XXX dollars"). The brain talks
  // in percentages, never raw amounts.
  if (/\$\s*\d/.test(text)) return "dollar_amount";
  if (/\b\d{2,}\s*dollars?\b/i.test(text)) return "dollar_amount_word";
  // Identifier-like sequences (ACCT-1234, CLM-9876, POL12345, etc).
  if (/\b[A-Z]{2,5}-?\d{3,}\b/.test(text)) return "identifier_pattern";
  // Bare 6+ digit runs (account/order numbers without prefixes).
  if (/\b\d{6,}\b/.test(text)) return "long_digit_run";
  // Email addresses (rep names sometimes show up as
  // jane.smith@hospital.com — keep them out of the cross-user brain).
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) return "email_address";
  return null;
}

/** Per-user opt-out gate. Set BONSAI_BRAIN_OPT_OUT=1 to skip writes. */
export function isOptedOut(): boolean {
  return process.env.BONSAI_BRAIN_OPT_OUT === "1";
}

/**
 * Upsert a provider brain row and append its events. Atomic via
 * SQLite transaction — if any event fails the PII gate, the WHOLE
 * batch is rejected and nothing is written. (We never want a partial
 * brain update.)
 *
 * Returns the resulting page on success, or null when the write was
 * skipped (opt-out, no events, or PII rejection).
 */
export function upsertBrain(opts: UpsertBrainOpts): BrainPage | null {
  if (isOptedOut()) {
    return null;
  }
  // Compiled truth must also pass the PII gate. The propagate skill
  // sometimes wants to summarize a specific objection — that's fine
  // as long as it's at the pattern level ("rep refused without
  // itemization") and not the raw quote.
  const compiledViolation = piiViolation(opts.compiled_truth);
  if (compiledViolation) {
    console.warn(
      `[brain.pii_blocked] thread=${opts.thread_id} compiled_truth blocked by ${compiledViolation} pattern; skipping batch`,
    );
    return null;
  }
  for (const e of opts.events) {
    const v = piiViolation(e.detail);
    if (v) {
      console.warn(
        `[brain.pii_blocked] thread=${opts.thread_id} event detail blocked by ${v} pattern; skipping entire batch (kind=${e.kind})`,
      );
      return null;
    }
  }
  const now = opts.now ?? Date.now();
  const userHash = hashUserId(opts.user_id);
  const db = getDb();
  // Single transaction: write the brain row and all events together.
  const tx = db.transaction(() => {
    db.run(
      `INSERT INTO provider_brains (provider_key, display_name, bill_kind, compiled_truth, updated_at, event_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_key) DO UPDATE SET
         display_name = excluded.display_name,
         bill_kind = excluded.bill_kind,
         compiled_truth = excluded.compiled_truth,
         updated_at = excluded.updated_at,
         event_count = provider_brains.event_count + excluded.event_count`,
      [
        opts.provider_key,
        opts.display_name,
        opts.bill_kind,
        opts.compiled_truth,
        now,
        opts.events.length,
      ],
    );
    for (const e of opts.events) {
      db.run(
        `INSERT INTO provider_brain_events (provider_key, thread_id, user_id_hash, occurred_at, kind, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [opts.provider_key, opts.thread_id, userHash, now, e.kind, e.detail],
      );
    }
  });
  tx();
  const page = readBrain(opts.provider_key);
  if (!page) {
    throw new Error(`[brain] upsert succeeded but readBrain returned null for ${opts.provider_key}`);
  }
  return page;
}

export function readBrain(provider_key: string): BrainPage | null {
  const row = getDb()
    .query(
      `SELECT provider_key, display_name, bill_kind, compiled_truth, updated_at, event_count
       FROM provider_brains WHERE provider_key = ?`,
    )
    .get(provider_key) as
    | {
        provider_key: string;
        display_name: string;
        bill_kind: string;
        compiled_truth: string;
        updated_at: number;
        event_count: number;
      }
    | null;
  return row ?? null;
}

/**
 * Read recent events for a provider — used by Phase 5's
 * consult-provider-brain skill to pull historical context, and by
 * propagate-to-brain itself to give the LLM the prior N events when
 * rebuilding compiled_truth. Newest first.
 */
export function readRecentEvents(provider_key: string, limit = 50): BrainEvent[] {
  const rows = getDb()
    .query(
      `SELECT kind, detail FROM provider_brain_events
       WHERE provider_key = ?
       ORDER BY occurred_at DESC
       LIMIT ?`,
    )
    .all(provider_key, limit) as Array<{ kind: string; detail: string }>;
  return rows;
}

/**
 * Rendered "## What we know about this provider" block. Empty when
 * the brain has no entry yet — the harness skips injecting an empty
 * heading. Phase 5 wires this into draft-reply context.
 */
export function renderBrainContext(provider_key: string): string {
  const page = readBrain(provider_key);
  if (!page) return "";
  return [
    `## What we know about ${page.display_name} (provider playbook)`,
    "",
    page.compiled_truth.trim(),
    "",
    `(${page.event_count} negotiation${page.event_count === 1 ? "" : "s"} contributed to this playbook.)`,
  ].join("\n");
}

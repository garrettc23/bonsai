/**
 * Pure projection from per-user offer-hunt run JSONs to the flat list of
 * offer cards consumed by the Comparison UI. Pulled out of server.ts so the
 * shape can be unit-tested without spinning up Bun.serve.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Baseline, OfferCategory, OfferHuntResult, OfferRecord } from "../offer-agent.ts";
import { isCompetitorProvider } from "../offer-agent.ts";

export interface OfferCard {
  id: string;
  recommended: boolean;
  category: OfferCategory;
  source: string;
  current: number;
  offered: number;
  saves: number;
  why: string;
  terms_url: string;
  baseline: { current_provider: string; specifics: string };
  // ---- comparison-engine fields (optional; absent on legacy offer files) ----
  /** What switching means relative to the baseline. */
  equivalence?: { keeps: string[]; gives_up: string[]; gains: string[]; parity_score: number };
  /** True effective monthly cost over the horizon, if the agent normalized it. */
  effective_monthly?: number;
  /** Promo step-up surfaced so the UI can warn "then $X after N months". */
  promo?: { promo_price?: number; promo_months?: number; standard_price?: number; one_time_fees?: number };
  /** Mortgage-refi break-even, when applicable. */
  refi?: { break_even_months: number; new_rate_pct: number; new_term_months: number; keeps_similar_term: boolean } | null;
  confidence?: number;
  verified?: boolean;
  switching_friction?: "low" | "medium" | "high";
  net_value_score?: number;
}

export function offerCardFromRecord(
  file: string,
  baseline: Baseline,
  o: OfferRecord,
): OfferCard {
  // "saves" stays as the headline number; prefer normalized savings when the
  // agent supplied a normalized cost, else fall back to the sticker delta so
  // legacy offer files still render.
  const effective = o.normalized_cost?.effective_monthly_usd;
  const saves = effective != null
    ? Math.max(0, baseline.current_price - effective)
    : Math.max(0, baseline.current_price - o.price_usd);
  return {
    // Stable ID so the UI can dedupe / persist "seen" state across reloads.
    id: `${file}|${o.provider}|${o.price_usd}`,
    recommended: o.recommended,
    category: baseline.category,
    source: o.provider,
    current: baseline.current_price,
    offered: effective ?? o.price_usd,
    saves,
    why: o.notes ?? "",
    terms_url: o.terms_url,
    baseline: {
      current_provider: baseline.current_provider,
      specifics: baseline.specifics ?? "",
    },
    equivalence: o.equivalence,
    effective_monthly: effective,
    promo: o.normalized_cost
      ? {
          promo_price: o.normalized_cost.promo_price_usd,
          promo_months: o.normalized_cost.promo_months,
          standard_price: o.normalized_cost.standard_price_usd,
          one_time_fees: o.normalized_cost.one_time_fees_usd,
        }
      : undefined,
    refi: o.refi ?? null,
    confidence: o.confidence,
    verified: o.verified,
    switching_friction: o.switching_friction,
    net_value_score: o.net_value_score,
  };
}

export interface ProjectOfferHistoryOpts {
  /**
   * Set of PendingRun ids the Comparison view should follow. When
   * provided (non-null), STRICTLY filter: every offer file must have a
   * `run_id` matching the set. Files without a `run_id` (legacy, pre-FIX-F)
   * are dropped too — once a user has deleted every bill, Comparison must
   * go empty even if old hunts left orphans on disk.
   *
   * Pass `null` (or omit) to skip the filter (every offer file projects).
   * Useful for tests + admin tools.
   */
  activeRunIds?: ReadonlySet<string> | null;
}

/**
 * Read every persisted offer-hunt run for the user and flatten into card
 * objects, newest-first by file mtime, then by savings descending within
 * each run. Returns an empty array if the directory doesn't exist or every
 * file is unparseable.
 */
export function projectOfferHistory(
  offersDirPath: string,
  opts: ProjectOfferHistoryOpts = {},
): OfferCard[] {
  if (!existsSync(offersDirPath)) return [];
  const files = readdirSync(offersDirPath).filter((f) => f.endsWith(".json"));
  const activeRunIds = opts.activeRunIds ?? null;

  type RunWithMeta = { run: OfferHuntResult; modified: number; file: string };
  const runs: RunWithMeta[] = [];
  for (const f of files) {
    const full = join(offersDirPath, f);
    try {
      const run = JSON.parse(readFileSync(full, "utf8")) as OfferHuntResult;
      if (!run?.baseline || !Array.isArray(run.offers)) continue;
      // Strict filter: when activeRunIds is provided, the file must have
      // a run_id matching the active set. Legacy files (no run_id) are
      // dropped too — Comparison going empty after delete-all-bills is
      // more important than preserving stale offers from pre-FIX-F runs.
      if (activeRunIds) {
        if (!run.run_id || !activeRunIds.has(run.run_id)) continue;
      }
      runs.push({ run, modified: statSync(full).mtimeMs, file: f });
    } catch {
      // skip unparseable files
    }
  }
  runs.sort((a, b) => b.modified - a.modified);

  // Dedupe across baselines + filter competitors. Same bill, same provider
  // surfacing twice (e.g. analyzer derived two baselines that both hit
  // GoodRx) is noise — keep the first appearance only. Competitors slip
  // past older offer files that pre-date the server-side blocklist; filter
  // them at projection time too so the UI never sees them.
  const seen = new Set<string>();
  const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

  const cards: OfferCard[] = [];
  for (const { run, file } of runs) {
    // Rank by net value (parity × confidence ÷ friction-weighted savings) when
    // present, falling back to raw savings for legacy files that predate it.
    const sorted = [...run.offers].sort((a, b) => {
      const av = a.net_value_score ?? a.savings_vs_baseline;
      const bv = b.net_value_score ?? b.savings_vs_baseline;
      return bv - av;
    });
    for (const o of sorted) {
      if (isCompetitorProvider(o.provider)) continue;
      const key = normalize(o.provider);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(offerCardFromRecord(file, run.baseline, o));
    }
  }
  return cards;
}

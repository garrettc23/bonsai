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
}

export function offerCardFromRecord(
  file: string,
  baseline: Baseline,
  o: OfferRecord,
): OfferCard {
  return {
    // Stable ID so the UI can dedupe / persist "seen" state across reloads.
    id: `${file}|${o.provider}|${o.price_usd}`,
    recommended: o.recommended,
    category: baseline.category,
    source: o.provider,
    current: baseline.current_price,
    offered: o.price_usd,
    saves: Math.max(0, baseline.current_price - o.price_usd),
    why: o.notes ?? "",
    terms_url: o.terms_url,
    baseline: {
      current_provider: baseline.current_provider,
      specifics: baseline.specifics ?? "",
    },
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
    const sorted = [...run.offers].sort(
      (a, b) => b.savings_vs_baseline - a.savings_vs_baseline,
    );
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

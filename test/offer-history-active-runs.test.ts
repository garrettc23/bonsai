/**
 * Comparison view follows Negotiation: only offers tied to a still-existing
 * bill should project. When all bills are deleted, Comparison goes empty.
 *
 * Two layered defenses:
 *   1. delete-bill sweeps offer files belonging to the deleted run.
 *   2. projectOfferHistory's `activeRunIds` filter drops orphans missed
 *      by step 1 (and pre-FIX-F files stay legacy-OK).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectOfferHistory } from "../src/lib/offer-history.ts";
import type { OfferHuntResult } from "../src/offer-agent.ts";

function makeRun(provider: string, runId: string | undefined): OfferHuntResult {
  return {
    baseline: {
      label: `${provider} test`,
      category: "prescription",
      current_provider: "Current Co",
      current_price: 100,
      specifics: "",
    },
    offers: [
      {
        provider,
        price_usd: 50,
        terms_url: "https://example.com",
        recommended: true,
        savings_vs_baseline: 50,
      },
    ],
    best: null,
    outcome: "lower_price_found",
    headline: "test",
    total_monthly_savings: 50,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    run_id: runId,
  };
}

function seedFile(dir: string, name: string, run: OfferHuntResult): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(run, null, 2));
}

describe("projectOfferHistory — activeRunIds filter", () => {
  test("drops offers whose run_id is not in the active set", () => {
    const dir = join(tmpdir(), `bonsai-active-${Date.now()}-${Math.random()}`);
    try {
      seedFile(dir, "1.json", makeRun("Costco", "run_alive"));
      seedFile(dir, "2.json", makeRun("Walmart", "run_deleted"));
      const cards = projectOfferHistory(dir, { activeRunIds: new Set(["run_alive"]) });
      expect(cards.length).toBe(1);
      expect(cards[0].source).toBe("Costco");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns empty array when active set has no matches", () => {
    const dir = join(tmpdir(), `bonsai-empty-${Date.now()}-${Math.random()}`);
    try {
      seedFile(dir, "1.json", makeRun("Costco", "run_a"));
      seedFile(dir, "2.json", makeRun("Walmart", "run_b"));
      const cards = projectOfferHistory(dir, { activeRunIds: new Set() });
      expect(cards.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy files without run_id still project (don't surprise-empty on deploy)", () => {
    const dir = join(tmpdir(), `bonsai-legacy-${Date.now()}-${Math.random()}`);
    try {
      seedFile(dir, "1.json", makeRun("Costco", undefined));
      const cards = projectOfferHistory(dir, { activeRunIds: new Set() });
      expect(cards.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no opts means no filter (admin / test escape hatch)", () => {
    const dir = join(tmpdir(), `bonsai-noopt-${Date.now()}-${Math.random()}`);
    try {
      seedFile(dir, "1.json", makeRun("Costco", "any_run"));
      const cards = projectOfferHistory(dir);
      expect(cards.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("competitor blocklist — expanded coverage", () => {
  test("blocks the new bill-management entries added in FIX G", async () => {
    const { isCompetitorProvider } = await import("../src/offer-agent.ts");
    for (const name of [
      "BillTrim", "BillCutterz", "Hiatus", "Buddy", "Subby", "Bobby",
      "MoneyLion", "Chime Bill Pay", "Quicken Bills",
    ]) {
      expect(isCompetitorProvider(name)).toBe(true);
    }
  });

  test("does not over-match (false positives are bugs)", async () => {
    const { isCompetitorProvider } = await import("../src/offer-agent.ts");
    for (const name of [
      "Costco Pharmacy", "Comcast", "Spectrum", "Mint Mobile",
      "T-Mobile", "GoodRx", "Mark Cuban Cost Plus Drugs",
    ]) {
      expect(isCompetitorProvider(name)).toBe(false);
    }
  });
});

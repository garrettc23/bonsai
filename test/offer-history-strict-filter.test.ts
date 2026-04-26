/**
 * Strict activeRunIds filter for projectOfferHistory.
 *
 * When `activeRunIds` is provided, EVERY offer file must have a `run_id`
 * matching the active set — including files that pre-date `run_id`
 * tagging. This is the only way Comparison can go empty when the user
 * deletes every bill: legacy orphans without run_id used to pass through.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectOfferHistory } from "../src/lib/offer-history.ts";
import type { OfferHuntResult } from "../src/offer-agent.ts";

function seedFile(dir: string, name: string, run: OfferHuntResult): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(run, null, 2));
}

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

describe("projectOfferHistory — strict activeRunIds", () => {
  test("legacy files (no run_id) are dropped when activeRunIds is provided", () => {
    const dir = join(tmpdir(), `bonsai-strict-${Date.now()}-${Math.random()}`);
    try {
      seedFile(dir, "1.json", makeRun("Costco", undefined));
      seedFile(dir, "2.json", makeRun("Walmart", "run_alive"));
      const cards = projectOfferHistory(dir, { activeRunIds: new Set(["run_alive"]) });
      // Only Walmart (in active set) survives; legacy Costco file is dropped.
      expect(cards.length).toBe(1);
      expect(cards[0].source).toBe("Walmart");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty activeRunIds → empty result, even with legacy files on disk", () => {
    // The exact "delete every bill, expect Comparison empty" scenario.
    const dir = join(tmpdir(), `bonsai-empty-strict-${Date.now()}-${Math.random()}`);
    try {
      seedFile(dir, "1.json", makeRun("Costco", undefined));
      seedFile(dir, "2.json", makeRun("Walmart", "run_old"));
      const cards = projectOfferHistory(dir, { activeRunIds: new Set() });
      expect(cards.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no activeRunIds opt → no filter (admin / migration paths still work)", () => {
    const dir = join(tmpdir(), `bonsai-noopt-${Date.now()}-${Math.random()}`);
    try {
      seedFile(dir, "1.json", makeRun("Costco", undefined));
      seedFile(dir, "2.json", makeRun("Walmart", "run_x"));
      const cards = projectOfferHistory(dir);
      expect(cards.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("activeRunIds: null → no filter (escape hatch)", () => {
    const dir = join(tmpdir(), `bonsai-null-${Date.now()}-${Math.random()}`);
    try {
      seedFile(dir, "1.json", makeRun("Costco", undefined));
      const cards = projectOfferHistory(dir, { activeRunIds: null });
      expect(cards.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Comparison offers: dedupe by provider name + block bill-negotiation
 * competitors.
 *
 * Two invariants:
 *   1. Same provider can't appear twice for one bill. The analyzer derives
 *      multiple baselines per bill (e.g. an Rx + a lab order); if both
 *      hunts happen to surface "GoodRx", the user should see one card,
 *      not two.
 *   2. Bonsai is itself a bill-negotiation service. Recommending a
 *      competitor (Goodbill, Trim, BillFixers, etc.) is a self-own.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectOfferHistory } from "../src/lib/offer-history.ts";
import { isCompetitorProvider } from "../src/offer-agent.ts";
import type { OfferHuntResult } from "../src/offer-agent.ts";

function seedOfferFile(dir: string, name: string, run: OfferHuntResult): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(run, null, 2));
}

function makeRun(provider: string, price: number, category: OfferHuntResult["baseline"]["category"], current = 100): OfferHuntResult {
  return {
    baseline: {
      label: `Test ${provider}`,
      category,
      current_provider: "Current Co",
      current_price: current,
      specifics: "",
    },
    offers: [
      {
        provider,
        price_usd: price,
        terms_url: "https://example.com/terms",
        recommended: true,
        savings_vs_baseline: current - price,
      },
    ],
    best: null,
    outcome: "lower_price_found",
    headline: "test",
    total_monthly_savings: current - price,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };
}

describe("isCompetitorProvider", () => {
  test("blocks Goodbill in any casing/punctuation", () => {
    expect(isCompetitorProvider("Goodbill")).toBe(true);
    expect(isCompetitorProvider("goodbill")).toBe(true);
    expect(isCompetitorProvider("Good Bill")).toBe(true);
    expect(isCompetitorProvider("good-bill")).toBe(true);
  });

  test("blocks the obvious bill-negotiation competitor list", () => {
    for (const name of ["Trim", "BillFixers", "Truebill", "Resolve", "Billshark", "Cushion", "Rocket Money"]) {
      expect(isCompetitorProvider(name)).toBe(true);
    }
  });

  test("does not block legitimate alternative providers", () => {
    for (const name of ["GoodRx", "Costco Pharmacy", "Comcast", "Spectrum", "Geico"]) {
      expect(isCompetitorProvider(name)).toBe(false);
    }
  });
});

describe("projectOfferHistory dedupe + competitor filter", () => {
  test("dedupes the same provider across baselines", () => {
    const dir = join(tmpdir(), `bonsai-offer-dedup-${Date.now()}-${Math.random()}`);
    try {
      seedOfferFile(dir, "1.json", makeRun("GoodRx", 12, "prescription"));
      // Force a different mtime so file 2 sorts after file 1
      const dir2 = dir;
      seedOfferFile(dir2, "2.json", makeRun("GoodRx", 14, "prescription"));
      const cards = projectOfferHistory(dir);
      const goodRxCount = cards.filter((c) => c.source.toLowerCase() === "goodrx").length;
      expect(goodRxCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filters out competitor providers even if they're on disk", () => {
    const dir = join(tmpdir(), `bonsai-offer-block-${Date.now()}-${Math.random()}`);
    try {
      seedOfferFile(dir, "1.json", makeRun("Goodbill", 5, "prescription"));
      seedOfferFile(dir, "2.json", makeRun("Costco Pharmacy", 9, "prescription"));
      const cards = projectOfferHistory(dir);
      expect(cards.find((c) => c.source === "Goodbill")).toBeUndefined();
      expect(cards.find((c) => c.source === "Costco Pharmacy")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legitimate providers across different categories all surface", () => {
    const dir = join(tmpdir(), `bonsai-offer-mix-${Date.now()}-${Math.random()}`);
    try {
      seedOfferFile(dir, "1.json", makeRun("Costco Pharmacy", 9, "prescription"));
      seedOfferFile(dir, "2.json", makeRun("Spectrum", 49, "insurance_plan", 79));
      const cards = projectOfferHistory(dir);
      expect(cards.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

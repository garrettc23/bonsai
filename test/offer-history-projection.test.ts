/**
 * Tests for projectOfferHistory — the read-side projection that flattens
 * persisted OfferHuntResult JSONs into the offer-card shape consumed by
 * the Comparison UI.
 *
 * The projection has three guarantees worth pinning down:
 *   1. Sort order is newest-run-first (mtime desc), then highest-savings
 *      first within each run, so the most recommended offer is always at
 *      the top of the grid.
 *   2. Stable IDs (file|provider|price) so the "seen" state survives
 *      reloads and renders aren't keyed on array index.
 *   3. Resilience to malformed run files — a corrupted JSON or a file
 *      missing baseline/offers is skipped, not propagated as a 500.
 *
 * We write fixture run JSONs to a tmpdir, call projectOfferHistory on it
 * directly, and assert the projected cards. No HTTP, no server bootstrap.
 *
 * Run: bun test test/offer-history-projection.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectOfferHistory } from "../src/lib/offer-history.ts";
import type { OfferHuntResult } from "../src/offer-agent.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bonsai-offer-history-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeRun(filename: string, run: OfferHuntResult, mtime?: Date): string {
  const full = join(tmpDir, filename);
  writeFileSync(full, JSON.stringify(run), "utf8");
  if (mtime) utimesSync(full, mtime, mtime);
  return full;
}

function fixtureRun(label: string, offers: OfferHuntResult["offers"]): OfferHuntResult {
  return {
    baseline: {
      label,
      category: "prescription",
      current_provider: "Acme Pharmacy",
      current_price: 80,
      specifics: "atorvastatin 20mg",
    },
    offers,
    best: offers.find((o) => o.recommended) ?? null,
    outcome: offers.length > 0 ? "lower_price_found" : "exhausted_no_results",
    headline: `${label} hunt`,
    total_monthly_savings: 50,
    started_at: "2026-04-25T00:00:00Z",
    completed_at: "2026-04-25T00:01:00Z",
  };
}

describe("projectOfferHistory", () => {
  test("returns [] when the directory does not exist", () => {
    const cards = projectOfferHistory(join(tmpDir, "does-not-exist"));
    expect(cards).toEqual([]);
  });

  test("flattens offers across runs, newest-first, savings-desc within each", () => {
    const older = fixtureRun("older", [
      {
        provider: "Indie Pharm",
        price_usd: 70,
        terms_url: "https://indie.example.com",
        recommended: false,
        savings_vs_baseline: 10,
      },
    ]);
    const newer = fixtureRun("newer", [
      {
        provider: "GoodRx",
        price_usd: 12,
        terms_url: "https://goodrx.com/x",
        recommended: true,
        notes: "Coupon at Walgreens",
        savings_vs_baseline: 68,
      },
      {
        provider: "Cost Plus",
        price_usd: 6.5,
        terms_url: "https://costplusdrugs.com/x",
        recommended: true,
        savings_vs_baseline: 73.5,
      },
    ]);

    writeRun("100-older.json", older, new Date("2026-04-20T00:00:00Z"));
    writeRun("200-newer.json", newer, new Date("2026-04-25T00:00:00Z"));

    const cards = projectOfferHistory(tmpDir);
    // Newer run first, with its highest-savings offer ahead of the lower one.
    expect(cards.map((c) => c.source)).toEqual(["Cost Plus", "GoodRx", "Indie Pharm"]);

    const top = cards[0];
    expect(top.recommended).toBe(true);
    expect(top.current).toBe(80);
    expect(top.offered).toBe(6.5);
    expect(top.saves).toBe(73.5);
    expect(top.terms_url).toBe("https://costplusdrugs.com/x");
    expect(top.baseline.current_provider).toBe("Acme Pharmacy");
    expect(top.baseline.specifics).toBe("atorvastatin 20mg");
    // Stable ID: file + provider + price
    expect(top.id).toBe("200-newer.json|Cost Plus|6.5");
  });

  test("malformed run files are skipped without breaking the projection", () => {
    writeRun(
      "good.json",
      fixtureRun("good", [
        {
          provider: "Cheaper Co",
          price_usd: 30,
          terms_url: "https://cheaper.example.com",
          recommended: true,
          savings_vs_baseline: 50,
        },
      ]),
    );
    writeFileSync(join(tmpDir, "broken.json"), "not json", "utf8");
    writeFileSync(join(tmpDir, "missing-baseline.json"), JSON.stringify({ offers: [] }), "utf8");
    // Non-json file should be ignored entirely (suffix check)
    writeFileSync(join(tmpDir, "README.md"), "# notes", "utf8");

    const cards = projectOfferHistory(tmpDir);
    expect(cards.length).toBe(1);
    expect(cards[0].source).toBe("Cheaper Co");
  });

  test("preserves recommended=false offers (UI filters them, projection does not)", () => {
    writeRun(
      "mixed.json",
      fixtureRun("mixed", [
        {
          provider: "Pricey",
          price_usd: 90,
          terms_url: "https://pricey.example.com",
          recommended: false,
          savings_vs_baseline: -10,
        },
      ]),
    );
    const cards = projectOfferHistory(tmpDir);
    expect(cards.length).toBe(1);
    expect(cards[0].recommended).toBe(false);
    expect(cards[0].saves).toBe(0); // Math.max(0, ...) clamps negative savings
  });
});

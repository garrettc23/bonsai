/**
 * Sample-bill curated offers fixture.
 *
 * fixtures/bill-001.offers.json ships pre-vetted alternative providers
 * so the demo flow doesn't burn a live agent run on something
 * deterministic — and doesn't surface bill-negotiation competitors that
 * would slip past the agent prompt's blocklist on a bad day.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompetitorProvider } from "../src/offer-agent.ts";
import type { OfferHuntResult } from "../src/offer-agent.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "fixtures", "bill-001.offers.json");
const SERVER = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf-8");

describe("fixtures/bill-001.offers.json", () => {
  const data = JSON.parse(readFileSync(FIXTURE, "utf-8")) as OfferHuntResult[];

  test("ships at least one offer entry", () => {
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  test("every offer has a real terms_url and a non-empty provider name", () => {
    for (const result of data) {
      expect(Array.isArray(result.offers)).toBe(true);
      for (const o of result.offers) {
        expect(o.provider.trim().length).toBeGreaterThan(0);
        expect(o.terms_url).toMatch(/^https?:\/\//);
      }
    }
  });

  test("none of the providers are bill-negotiation competitors", () => {
    for (const result of data) {
      for (const o of result.offers) {
        expect(isCompetitorProvider(o.provider)).toBe(false);
      }
    }
  });

  test("every recommended offer beats its baseline", () => {
    for (const result of data) {
      for (const o of result.offers) {
        if (!o.recommended) continue;
        expect(o.savings_vs_baseline).toBeGreaterThan(0);
        expect(o.price_usd).toBeLessThan(result.baseline.current_price);
      }
    }
  });
});

describe("runOfferHuntsForRun fixture fast-path", () => {
  test("server.ts has the fixtures/<name>.offers.json fast-path", () => {
    expect(SERVER).toContain(`${"$"}{start.fixture_name}.offers.json`);
    expect(SERVER).toMatch(/fixtureOffersPath/);
  });

  test("fast-path writes offers stamped with the run_id", () => {
    // Each fixture entry is forwarded through saveOfferHunt with the
    // current runId stamped on it so projectOfferHistory's active-run
    // filter still works.
    const fnStart = SERVER.indexOf("async function runOfferHuntsForRun");
    const fnSlice = SERVER.slice(fnStart, fnStart + 3000);
    expect(fnSlice).toMatch(/saveOfferHunt\(\s*\{[^}]*run_id:\s*runId/s);
  });
});

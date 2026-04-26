/**
 * Comparison page "Potential savings if you switch to all recommended"
 * banner cap.
 *
 * Hard invariant: the figure can never exceed the cumulative amount the
 * user is paying across all attached bills. Per-baseline currents can
 * overlap (one bill's analyzer-derived "ER visit" baseline + "imaging"
 * baseline + "hospital balance" baseline are slices of the same bill,
 * not additive). The honest cap is the sum of the bills' totals.
 *
 * Source-level structural checks — the banner math runs in app.js inside
 * renderOffers, no jsdom in this repo.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(__dirname, "..", "public", "assets", "app.js"), "utf-8");
const INDEX_HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf-8");

describe("renderOffers banner-amount", () => {
  test("does NOT multiply by 12 — savings figure isn't annualized", () => {
    // Some bills are one-time (medical), some recurring (telecom). Annualizing
    // a one-time charge produces nonsense. Showing total-potential-savings
    // is honest in both cases.
    expect(APP_JS).not.toMatch(/annualSaves\b/);
    expect(APP_JS).not.toMatch(/\* 12.*reduce/s);
  });

  test("groups recommended offers by baseline and keeps the best per group", () => {
    expect(APP_JS).toContain("bestByBaseline");
    expect(APP_JS).toMatch(/current_provider.*category/s);
  });

  test("caps savings at the sum of attached bills' totals", () => {
    // The cap is from historyCache, not from per-baseline currents.
    expect(APP_JS).toContain("totalAttachedSpend");
    expect(APP_JS).toMatch(/historyCache.*audits/s);
    expect(APP_JS).toMatch(/Math\.min\(rawSavings,\s*totalAttachedSpend\)/);
  });

  test("cap reads original_balance with final_balance fallback", () => {
    expect(APP_JS).toMatch(/final_balance.*original_balance/s);
  });

  test("hides the banner when there's no recommendation or capped savings is zero", () => {
    expect(APP_JS).toMatch(/banner\.hidden\s*=\s*bestList\.length\s*===\s*0\s*\|\|\s*cappedSavings\s*<=\s*0/);
  });

  test("eyebrow is reframed away from 'Annual'", () => {
    // "Annual" misled users into expecting annualized math. "Potential"
    // matches the new figure (total potential savings if every recommended
    // switch happens).
    expect(INDEX_HTML).toContain("Potential savings if you switch to all recommended");
    expect(INDEX_HTML).not.toContain("Annual savings if you switch");
  });
});

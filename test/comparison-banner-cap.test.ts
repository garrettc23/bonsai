/**
 * Comparison page "Annual savings if you switch to all recommended"
 * banner cap.
 *
 * Two invariants:
 *   1. The figure is annual, not monthly. The eyebrow says so explicitly.
 *   2. The figure can never exceed what the user is paying TODAY across
 *      the recommended baselines (you can't save $10k/yr on services
 *      that cost $4k/yr — that's marketing fiction).
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

describe("renderOffers banner-amount", () => {
  test("multiplies monthly savings by 12 for the annual display", () => {
    expect(APP_JS).toMatch(/\* 12/);
    expect(APP_JS).toContain("annualSaves");
  });

  test("groups recommended offers by baseline and keeps the best per group", () => {
    // Multiple alternative offers for the same baseline shouldn't
    // double-count. We pick the best (largest saves) per baseline.
    expect(APP_JS).toContain("bestByBaseline");
    expect(APP_JS).toMatch(/current_provider.*category/s);
  });

  test("clamps annual savings to current annual spend across recommended baselines", () => {
    expect(APP_JS).toContain("monthlyCurrent");
    expect(APP_JS).toMatch(/Math\.min\(monthlySaves,\s*monthlyCurrent\)/);
  });

  test("hides the banner when there's no recommendation or savings is zero", () => {
    // Don't earn page real estate on an empty / zero state.
    expect(APP_JS).toMatch(/banner\.hidden\s*=\s*bestList\.length\s*===\s*0\s*\|\|\s*annualSaves\s*<=\s*0/);
  });
});

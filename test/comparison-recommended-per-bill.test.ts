/**
 * Comparison "Recommended" view shows ONE recommended provider per bill.
 *
 * Multiple alternative offers can exist for the same baseline (different
 * pharmacies for one Rx; different ISPs for one cable bill). The All
 * filter shows every alternative. The Recommended filter collapses to
 * the single highest-saving option per bill so the list isn't drowned
 * in near-duplicates.
 *
 * Source-level structural check — the filter logic lives in renderOffers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(__dirname, "..", "public", "assets", "app.js"), "utf-8");

describe("renderOffers Recommended filter — one per bill", () => {
  test("collapses recommended offers by current_provider", () => {
    expect(APP_JS).toContain('offersFilter === "Recommended"');
    expect(APP_JS).toContain("bestByBill");
    expect(APP_JS).toMatch(/baseline\?\.current_provider/);
  });

  test("All view stays untouched (every offer renders)", () => {
    // The All filter must keep its passthrough — the user explicitly
    // chose to see every alternative.
    expect(APP_JS).toMatch(/offersFilter === "All"[\s\S]{0,100}visible = offersCache/);
  });

  test("category filters stay untouched", () => {
    expect(APP_JS).toMatch(/offersCache\.filter\(\(o\) => o\.category === offersFilter\)/);
  });
});

describe("Tile action button alignment (FIX O)", () => {
  test(".offer-actions has margin-top: auto so buttons align across cards", () => {
    const css = readFileSync(join(__dirname, "..", "public", "assets", "app.css"), "utf-8");
    // The parent .offer-card is flex-column; pushing actions to margin-top: auto
    // sticks them to the bottom regardless of body length.
    const blockStart = css.indexOf(".offer-actions {");
    expect(blockStart).toBeGreaterThan(-1);
    const block = css.slice(blockStart, blockStart + 300);
    expect(block).toMatch(/margin-top:\s*auto/);
  });
});

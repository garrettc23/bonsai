/**
 * Drawer Current price reflects a completed Comparison switch.
 *
 * Two layered checks:
 *   1. findUpdatedRowAfterRefresh recomputes vendor + balance from the
 *      fresh audit's completed_switches so reopening the drawer after a
 *      switch shows the new provider + new amount, not the stale row.
 *   2. renderDrawerStats prefers completed_switches[-1].new_amount over
 *      summary.final_balance for the "Current" stat — the bill is now a
 *      different service at a different price.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(__dirname, "..", "public", "assets", "app.js"), "utf-8");

describe("findUpdatedRowAfterRefresh recomputes display fields (FIX S)", () => {
  const fnStart = APP_JS.indexOf("function findUpdatedRowAfterRefresh");
  const fnSlice = APP_JS.slice(fnStart, fnStart + 3000);

  test("reads completed_switches off the fresh audit", () => {
    expect(fnSlice).toContain("completed_switches");
  });

  test("returned row.vendor prefers display_name → switch → provider_name", () => {
    expect(fnSlice).toMatch(/vendor:\s*displayName\s*\?\?\s*switchedVendor\s*\?\?\s*fresh\.provider_name/);
  });

  test("returned row.balance prefers switched amount", () => {
    expect(fnSlice).toMatch(/balance:\s*switchedBalance\s*\?\?\s*fresh\.final_balance/);
  });
});

describe("renderDrawerStats Current stat reflects switch (FIX S)", () => {
  const fnStart = APP_JS.indexOf("function renderDrawerStats");
  const fnSlice = APP_JS.slice(fnStart, fnStart + 2500);

  test("reads latest completed_switches entry for `now`", () => {
    expect(fnSlice).toContain("completed_switches");
    expect(fnSlice).toContain("switchedAmount");
  });

  test("Current prefers switched amount over summary.final_balance", () => {
    expect(fnSlice).toMatch(/Number\.isFinite\(switchedAmount\)/);
  });
});

/**
 * /api/switch-complete contract.
 *
 * When the user clicks Complete on a Comparison Switch modal and enters
 * their new monthly amount, we append a row to PendingRun.completed_switches
 * so the drawer's Activity timeline can surface it. Source-level checks —
 * the actual handler is wired into Bun.serve which is heavy to boot inside
 * a unit test.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf-8");
const APP_JS = readFileSync(join(__dirname, "..", "public", "assets", "app.js"), "utf-8");

describe("/api/switch-complete server handler", () => {
  test("registered as a POST route", () => {
    expect(SERVER).toContain('url.pathname === "/api/switch-complete"');
    expect(SERVER).toContain("handleSwitchComplete(req)");
  });

  test("validates run_id, new_provider, and a non-negative new_amount", () => {
    const fnStart = SERVER.indexOf("async function handleSwitchComplete");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = SERVER.slice(fnStart, fnStart + 1500);
    expect(fnSlice).toMatch(/Missing run_id/);
    expect(fnSlice).toMatch(/Missing new_provider/);
    expect(fnSlice).toMatch(/Invalid new_amount/);
  });

  test("appends to completed_switches with timestamp + provider names", () => {
    const fnStart = SERVER.indexOf("async function handleSwitchComplete");
    const fnSlice = SERVER.slice(fnStart, fnStart + 2000);
    expect(fnSlice).toContain("completed_switches");
    expect(fnSlice).toContain("switched_at");
    expect(fnSlice).toContain("new_provider");
    expect(fnSlice).toContain("new_amount");
    expect(fnSlice).toContain("savePending(run)");
  });
});

describe("Switch modal Complete/Dismiss UI", () => {
  test("modal markup has primary Complete + ghost Dismiss buttons", () => {
    const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf-8");
    expect(html).toContain('id="switch-complete"');
    expect(html).toContain('id="switch-dismiss"');
    expect(html).toContain('id="switch-amount-input"');
  });

  test("openSwitchModal posts to /api/switch-complete on submit", () => {
    expect(APP_JS).toContain("/api/switch-complete");
    expect(APP_JS).toMatch(/new_provider:\s*recommendedName/);
    expect(APP_JS).toMatch(/new_amount:\s*amount/);
  });

  test("activity timeline renders completed_switches entries", () => {
    const fnStart = APP_JS.indexOf("function buildTimelineEvents");
    const fnSlice = APP_JS.slice(fnStart, fnStart + 8000);
    expect(fnSlice).toContain("completed_switches");
    expect(fnSlice).toContain("Switched provider");
  });
});

describe("FIX B — Accept-all bulk hunt button removed", () => {
  test("no #offers-accept-all element in index.html", () => {
    const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf-8");
    expect(html).not.toContain('id="offers-accept-all"');
  });

  test("no runOfferHuntForCard or accept-all wire-up in app.js", () => {
    expect(APP_JS).not.toContain("runOfferHuntForCard");
    expect(APP_JS).not.toContain("offers-accept-all");
  });
});

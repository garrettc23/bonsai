/**
 * Click-to-edit bill name in the drawer header.
 *
 * Backend: /api/bill-rename idempotent endpoint. Sets or clears
 * PendingRun.display_name. Empty string clears.
 *
 * Frontend: drawer title is contenteditable, blur autosaves, Enter
 * commits, Escape reverts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf-8");
const APP_JS = readFileSync(join(__dirname, "..", "public", "assets", "app.js"), "utf-8");
const INDEX_HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf-8");

describe("/api/bill-rename server handler", () => {
  test("registered as a POST route", () => {
    expect(SERVER).toContain('url.pathname === "/api/bill-rename"');
    expect(SERVER).toContain("handleBillRename(req)");
  });

  test("validates run_id and bounds display_name length", () => {
    const fnStart = SERVER.indexOf("async function handleBillRename");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = SERVER.slice(fnStart, fnStart + 1500);
    expect(fnSlice).toMatch(/Missing run_id/);
    expect(fnSlice).toMatch(/display_name too long/);
    expect(fnSlice).toMatch(/length\s*>\s*200/);
  });

  test("empty display_name clears the override", () => {
    const fnStart = SERVER.indexOf("async function handleBillRename");
    const fnSlice = SERVER.slice(fnStart, fnStart + 1500);
    // When `next` is empty, we delete the field rather than setting empty string.
    expect(fnSlice).toMatch(/delete run\.display_name/);
  });

  test("PendingRun has a display_name field", () => {
    expect(SERVER).toMatch(/display_name\?:\s*string/);
  });
});

describe("display_name surfaces on history audit rows", () => {
  test("handleHistory exposes display_name on completed audit rows", () => {
    const completedRowMatch = SERVER.match(/completed_switches:\s*pending\?\.completed_switches[\s\S]{0,200}display_name:\s*pending\?\.display_name/);
    expect(completedRowMatch).not.toBeNull();
  });

  test("handleHistory exposes display_name on inflight rows", () => {
    const inflightRowMatch = SERVER.match(/completed_switches:\s*run\.completed_switches[\s\S]{0,200}display_name:\s*run\.display_name/);
    expect(inflightRowMatch).not.toBeNull();
  });
});

describe("Drawer click-to-edit title", () => {
  test("drawer-title has contenteditable affordance markers", () => {
    expect(INDEX_HTML).toMatch(/id="drawer-title".*data-edit-hint/);
  });

  test("wireDrawerTitleEdit posts to /api/bill-rename on blur", () => {
    expect(APP_JS).toContain("function wireDrawerTitleEdit");
    expect(APP_JS).toContain("/api/bill-rename");
    expect(APP_JS).toMatch(/display_name:\s*next/);
  });

  test("Enter commits, Escape reverts", () => {
    const fnStart = APP_JS.indexOf("function wireDrawerTitleEdit");
    const fnSlice = APP_JS.slice(fnStart, fnStart + 3000);
    expect(fnSlice).toMatch(/ev\.key === "Enter"/);
    expect(fnSlice).toMatch(/ev\.key === "Escape"/);
  });

  test("only enabled for real audit rows (mocks can't round-trip)", () => {
    const fnStart = APP_JS.indexOf("function wireDrawerTitleEdit");
    const fnSlice = APP_JS.slice(fnStart, fnStart + 3000);
    expect(fnSlice).toMatch(/contentEditable\s*=\s*"false"/);
    expect(fnSlice).toMatch(/row\.kind\s*!==\s*"audit"/);
  });
});

describe("Bills list reads display_name override", () => {
  test("renderBills' row vendor prefers display_name", () => {
    // display_name wins over the switched provider, the analyzer
    // provider_name, and the fixture display map.
    expect(APP_JS).toMatch(/vendor:\s*a\.display_name\s*\?\?\s*switchedVendor/);
  });
});

/**
 * Switch modal amount input formats as currency as the user types.
 *
 * The previous v0.1.31.0 input was raw `<input type="number">` so the
 * value rendered as `59.99` — readable, but the eyebrow says "USD" and
 * users expect to see the dollar sign + thousands separators while
 * typing. The formatter strips invalid characters, caps the decimal at
 * 2 digits, and prefixes "$".
 *
 * Source-level structural checks — the formatter logic lives in app.js.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(__dirname, "..", "public", "assets", "app.js"), "utf-8");
const INDEX_HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf-8");

describe("formatCurrencyInput formatter", () => {
  test("exists and is wired to the Switch amount input", () => {
    expect(APP_JS).toContain("function formatCurrencyInput");
    expect(APP_JS).toContain("function attachCurrencyFormatter");
    // Wired on input event so format updates as the user types.
    expect(APP_JS).toMatch(/input\.addEventListener\("input"/);
    // Wired on blur so $59 normalizes to $59.00.
    expect(APP_JS).toMatch(/input\.addEventListener\("blur"/);
  });

  test("Switch modal amount input is type=text + currency-formatter wired", () => {
    // Type=text + inputmode=decimal lets us format $1,234.56 in place
    // while still surfacing the numeric keypad on mobile.
    const inputMatch = INDEX_HTML.match(/<input[^>]*id="switch-amount-input"[^>]*>/);
    expect(inputMatch).not.toBeNull();
    expect(inputMatch![0]).toContain('type="text"');
    expect(inputMatch![0]).toContain('inputmode="decimal"');
    expect(APP_JS).toMatch(/attachCurrencyFormatter\(amountInput\)/);
  });

  test("submit parses the formatted display string back to a number", () => {
    // The submit handler reuses formatCurrencyInput to extract the value
    // so "$1,234.56" → 1234.56 round-trips cleanly.
    const fnStart = APP_JS.indexOf("function openSwitchModal");
    const fnSlice = APP_JS.slice(fnStart, fnStart + 8000);
    expect(fnSlice).toMatch(/formatCurrencyInput\(raw\)/);
  });

  test("default amount uses the offer's recommended price (formatted)", () => {
    const fnStart = APP_JS.indexOf("function openSwitchModal");
    const fnSlice = APP_JS.slice(fnStart, fnStart + 8000);
    expect(fnSlice).toMatch(/offer\.offered/);
    expect(fnSlice).toMatch(/toLocaleString\("en-US"/);
  });
});

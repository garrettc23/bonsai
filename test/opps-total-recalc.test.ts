/**
 * Headline-savings recalculation contract.
 *
 * The dismiss-an-opportunity bug came from clamping the headline total to
 * the bill cap, so dismissing a $200 opp off a $7,000 raw total kept
 * showing $5,000 (the cap) until raw fell below cap. Headline now uses
 * the raw sum so each dismiss reduces the figure 1:1.
 *
 * No jsdom in this repo — this is a source-level structural check that
 * guards the right code path: renderOpportunities must NOT call
 * clampSaved on the headline total, must include the "estimated"
 * qualifier, and the receipts path (post-resolution actuals) must
 * continue to clamp.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(__dirname, "..", "public", "assets", "app.js");
const INDEX_HTML = join(__dirname, "..", "public", "index.html");

function extractFunction(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start === -1) throw new Error(`Could not find function: ${header}`);
  let depth = 0;
  let i = source.indexOf("{", start);
  if (i === -1) throw new Error(`No opening brace after: ${header}`);
  const bodyStart = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`Unterminated function body for: ${header}`);
}

const appJs = readFileSync(APP_JS, "utf-8");
const indexHtml = readFileSync(INDEX_HTML, "utf-8");

describe("renderOpportunities headline total", () => {
  // Disambiguate from `renderOpportunitiesSkeleton` by anchoring on the
  // empty arg list of the live render function.
  const body = extractFunction(appJs, "function renderOpportunities()");

  test("does NOT clamp headline total to the bill cap", () => {
    expect(body).not.toContain("clampSaved(rawTotal, cap)");
    expect(body).not.toContain("clampSaved(rawTotal,cap)");
  });

  test("uses the raw sum of visible opportunity estimates", () => {
    expect(body).toMatch(/visible\.reduce\(.*estimate/s);
  });

  test("toggles the estimated qualifier visibility based on total", () => {
    expect(body).toContain("opps-total-qualifier");
  });
});

describe("renderReceipts (post-resolution actuals)", () => {
  test("still uses clampSaved per-receipt", () => {
    // The receipts page renders actuals; clamping there is correct
    // because real-world saved can't exceed the bill amount. This is the
    // path we explicitly do NOT touch.
    expect(appJs).toContain("clampSaved(r.patient_saved, r.original_balance)");
  });
});

describe("opps-total-qualifier markup", () => {
  test("index.html has the qualifier span next to #opps-total", () => {
    expect(indexHtml).toContain('id="opps-total-qualifier"');
    expect(indexHtml).toContain("opps-total-wrap");
  });
});

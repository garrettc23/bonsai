/**
 * Structural contract test guarding the "approve also kicks the offer
 * hunt" backstop. If the audit-time hunt failed (or never fired because
 * deriveOfferBaselines returned []), the approve-time call is the only
 * thing that gets a user offers when they accept and walk away.
 *
 * Source-level structural check (no jsdom, no live server) — same pattern
 * as test/approve-no-modal.test.ts.
 *
 * Run: bun test test/handle-approve-fires-hunt.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = join(__dirname, "..", "src", "server.ts");

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

const source = readFileSync(SERVER_TS, "utf-8");
const approveBody = extractFunction(source, "async function handleApprove");

describe("handleApprove fires the offer hunt", () => {
  test("calls runOfferHuntsForRun with deriveOfferBaselines", () => {
    expect(approveBody).toContain("deriveOfferBaselines");
    expect(approveBody).toContain("runOfferHuntsForRun");
  });

  test("uses fire-and-forget (void or .catch), never awaits the hunt", () => {
    // The hunt must not block the response. Acceptable shapes:
    //   void runOfferHuntsForRun(...)
    //   runOfferHuntsForRun(...).catch(
    // Forbidden:
    //   await runOfferHuntsForRun(
    const fireAndForget =
      /void\s+runOfferHuntsForRun\s*\(/.test(approveBody) ||
      /runOfferHuntsForRun\s*\([\s\S]*?\)\s*\.catch\s*\(/.test(approveBody);
    expect(fireAndForget).toBe(true);

    // Hard rule: no `await runOfferHuntsForRun(` — that would block the
    // approve response on a 30-90s managed-agent hunt.
    const awaited = /await\s+runOfferHuntsForRun\s*\(/.test(approveBody);
    expect(awaited).toBe(false);
  });

  test("still kicks the negotiation worker", () => {
    expect(approveBody).toContain("kickoffNegotiation");
  });
});

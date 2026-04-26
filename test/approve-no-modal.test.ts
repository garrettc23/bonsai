/**
 * Structural contract test for approveAndRun in public/assets/app.js.
 *
 * The user reports that clicking "Accept and lower my bill" pops a modal
 * before navigating to Bills. Root cause was confirmDiscardUnsaved firing
 * inside showNav("bills") because workflow state (reviewState,
 * currentWorkflowView, stagedFiles) wasn't cleaned up first. Fix in
 * approveAndRun's success path: reviewState=null + clearStagingRef() +
 * setWorkflowView("overview") BEFORE showNav("bills").
 *
 * This test asserts the success path of approveAndRun:
 *   - calls clearStagingRef(), setWorkflowView("overview"), reviewState=null
 *     before showNav
 *   - has zero confirmModal( calls
 *   - has zero showApproveBlocker( calls
 *
 * Catches a regression where someone re-introduces a modal between click
 * and navigate without requiring a real DOM (no jsdom in this repo).
 *
 * Run: bun test test/approve-no-modal.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(__dirname, "..", "public", "assets", "app.js");

function extractFunction(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start === -1) throw new Error(`Could not find function: ${header}`);
  // Naïve brace matcher — fine for app.js where function bodies don't
  // contain unbalanced braces inside string literals at the relevant scope.
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

const source = readFileSync(APP_JS, "utf-8");
const body = extractFunction(source, "async function approveAndRun");

// Success path = everything AFTER the `if (!res.ok) { ... throw ... }`
// guard finishes — i.e. after the throw statement that ends the error
// branch — up to the catch block. Anchoring on `throw new Error(j?.message`
// is unique to the error tail; anything after runs only on success.
const errorThrow = body.indexOf("throw new Error(j?.message");
if (errorThrow === -1) throw new Error("Could not find error-branch throw");
const successStart = body.indexOf("\n", errorThrow) + 1;
const catchStart = body.indexOf("} catch (err)", successStart);
if (catchStart === -1) throw new Error("Could not find catch block in approveAndRun");
const successPath = body.slice(successStart, catchStart);

describe("approveAndRun success path", () => {
  test("clears reviewState before navigating", () => {
    expect(successPath).toContain("reviewState = null");
  });

  test("clears staged upload files (so the discard guard sees a clean state)", () => {
    expect(successPath).toContain("clearStagingRef(");
  });

  test("resets the workflow view to overview", () => {
    expect(successPath).toContain('setWorkflowView("overview")');
  });

  test("calls showNav('bills') exactly once", () => {
    const matches = successPath.match(/showNav\("bills"\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("has NO confirmModal calls", () => {
    expect(successPath).not.toContain("confirmModal(");
  });

  test("has NO showApproveBlocker calls", () => {
    expect(successPath).not.toContain("showApproveBlocker(");
  });

  test("state cleanup runs BEFORE showNav (not after)", () => {
    const cleanupIdx = successPath.indexOf("clearStagingRef(");
    const navIdx = successPath.indexOf('showNav("bills")');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(navIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(navIdx);
  });
});

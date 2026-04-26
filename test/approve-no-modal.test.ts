/**
 * Structural contract test guarding the "click Accept → land in Bills"
 * flow against the discard-confirmation modal regression.
 *
 * Two angles, same root cause:
 *   1. approveAndRun's success path must not call confirmModal /
 *      showApproveBlocker between the API success and the navigation.
 *   2. hasInFlightAuditWork() must not key off staged files. Staged
 *      uploads on the home page are cheap to re-drop — gating the
 *      discard prompt on them was what fired the modal between click
 *      and Bills view, and also what made dropping a file on home
 *      pop a modal as soon as the user clicked any nav tab.
 *
 * No jsdom in this repo, so this is a source-level structural check —
 * cheap, fast, and catches the most likely regression (someone wiring
 * the staging guard back in, or someone adding a confirmModal to the
 * approve success path).
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

// Success path of approveAndRun = everything after the error-branch throw
// through the catch block. Anchoring on `throw new Error(j?.message` is
// unique to the error tail; anything after runs only on success.
const approveBody = extractFunction(source, "async function approveAndRun");
const errorThrow = approveBody.indexOf("throw new Error(j?.message");
if (errorThrow === -1) throw new Error("Could not find error-branch throw");
const successStart = approveBody.indexOf("\n", errorThrow) + 1;
const catchStart = approveBody.indexOf("} catch (err)", successStart);
if (catchStart === -1) throw new Error("Could not find catch block");
const approveSuccess = approveBody.slice(successStart, catchStart);

const inFlightBody = extractFunction(source, "function hasInFlightAuditWork");

describe("approveAndRun success path", () => {
  test("clears reviewState before navigating", () => {
    expect(approveSuccess).toContain("reviewState = null");
  });

  test("calls showNav('bills') exactly once", () => {
    const matches = approveSuccess.match(/showNav\("bills"\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("has NO confirmModal calls", () => {
    expect(approveSuccess).not.toContain("confirmModal(");
  });

  test("has NO showApproveBlocker calls", () => {
    expect(approveSuccess).not.toContain("showApproveBlocker(");
  });
});

describe("hasInFlightAuditWork", () => {
  test("does NOT count staged files as in-flight work", () => {
    // Dropping a bill on the home page and clicking another tab must
    // not pop the discard modal — staged files are cheap to re-drop.
    expect(inFlightBody).not.toContain("hasStagedUpload");
  });

  test("still guards the progress and review sub-views", () => {
    expect(inFlightBody).toContain('currentWorkflowView === "progress"');
    expect(inFlightBody).toContain('currentWorkflowView === "review"');
    expect(inFlightBody).toContain("reviewState != null");
  });

  test("still guards an in-progress complaint draft", () => {
    expect(inFlightBody).toContain("hasComplaintInProgress");
  });
});

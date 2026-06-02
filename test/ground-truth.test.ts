/**
 * Tests for the grounding contract — the thing that prevents Bonsai from
 * sending a hallucinated billing error to a real billing department.
 *
 * `quoteAppearsIn` is the gate every record_error call passes through
 * (see src/tools/record-error.ts). If it returns a false positive, a
 * fabricated line_quote ships. If it returns a false negative, a real
 * finding gets dropped. Both are bad, so we pin both directions here.
 *
 * These are pure-function tests: no network, no model, fully deterministic.
 *
 * Run: bun test test/ground-truth.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  normalize,
  quoteAppearsIn,
  loadGroundTruth,
  groundTruthFromText,
} from "../src/lib/ground-truth.ts";

describe("normalize", () => {
  test("drops markdown structural chars and lowercases", () => {
    expect(normalize("**Current Balance Due**")).toBe("current balance due");
    expect(normalize("| 71046 | Chest X-ray |")).toBe("71046 chest x-ray");
  });

  test("treats colons as separators and collapses whitespace", () => {
    expect(normalize("Patient:   Jane Q. Doe")).toBe("patient jane q. doe");
  });

  test("trims surrounding whitespace", () => {
    expect(normalize("   #Heading#   ")).toBe("heading");
  });
});

describe("quoteAppearsIn — fixture bill-001", () => {
  const truth = loadGroundTruth("bill-001");

  test("verbatim bill line is found", () => {
    expect(quoteAppearsIn("Chest X-ray, 2 views", truth).found).toBe(true);
  });

  test("a full markdown table row (with pipes) is found after normalization", () => {
    // Claude reads the PDF, which has no pipes; our source markdown does.
    // The quote it returns won't have pipes — normalization bridges that.
    expect(
      quoteAppearsIn("03/14/2026 71046 Chest X-ray, 2 views 1 $468.00", truth).found,
    ).toBe(true);
  });

  test("balance-due line is found despite bold markers in the source", () => {
    expect(quoteAppearsIn("Current Balance Due", truth).found).toBe(true);
  });

  test("a fabricated line is rejected", () => {
    const r = quoteAppearsIn("Robotic Surgery Assistance Fee $9,999.00", truth);
    expect(r.found).toBe(false);
    expect(r.reason).toContain("not found in bill");
  });
});

describe("quoteAppearsIn — matching strategy edges", () => {
  const truth = groundTruthFromText(
    "the quick brown fox jumps over the lazy dog",
    "test://phrase",
  );

  test("too-short quote is rejected with a clear reason", () => {
    const r = quoteAppearsIn("ab", truth);
    expect(r.found).toBe(false);
    expect(r.reason).toContain("too short");
  });

  test("direct substring match", () => {
    expect(quoteAppearsIn("brown fox jumps", truth).found).toBe(true);
  });

  test("80% consecutive-token fallback tolerates one stray token", () => {
    // Direct substring fails (trailing 'zzz' not in truth), but the leading
    // 4-of-5 token window "quick brown fox jumps" is present.
    const r = quoteAppearsIn("quick brown fox jumps zzz", truth);
    expect(r.found).toBe(true);
  });

  test("a quote with no real overlap is rejected", () => {
    expect(quoteAppearsIn("completely unrelated invoice text", truth).found).toBe(false);
  });
});

describe("loadGroundTruth", () => {
  test("strips the YAML front matter from the fixture markdown", () => {
    const truth = loadGroundTruth("bill-001");
    expect(truth.text.startsWith("---")).toBe(false);
    expect(truth.text).not.toContain("pdf_options");
    expect(truth.text).toContain("ST. SYNTHETIC REGIONAL HOSPITAL");
  });

  test("accepts bare name, .md, and .pdf forms identically", () => {
    const bare = loadGroundTruth("bill-001").normalized;
    expect(loadGroundTruth("bill-001.md").normalized).toBe(bare);
    expect(loadGroundTruth("bill-001.pdf").normalized).toBe(bare);
  });
});

describe("groundTruthFromText", () => {
  test("builds a normalized form and preserves the source tag", () => {
    const gt = groundTruthFromText("| Hello World |", "upload://x");
    expect(gt.text).toBe("| Hello World |");
    expect(gt.normalized).toBe("hello world");
    expect(gt.source).toBe("upload://x");
  });
});

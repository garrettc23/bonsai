/**
 * Pure-function tests for the Finder-style provider dedup helper used by
 * the Bills list and the Receipts hero. Same function lives mirrored in
 * public/assets/app.js — keep them in sync.
 *
 * Run: bun test test/dedup-display-names.test.ts
 */
import { describe, expect, test } from "bun:test";
import { computeDisplayNames } from "../src/lib/display-names.ts";

interface Row {
  name: string;
  provider_name: string | null;
}

const opts = {
  getKey: (r: Row) => r.name,
  getName: (r: Row) => r.provider_name,
};

// Inputs are NEWEST-FIRST (matches the order /api/history and
// /api/receipts return). The oldest entry keeps the unsuffixed name; newer
// dupes pick up "(1)", "(2)", etc.

describe("computeDisplayNames", () => {
  test("empty input returns empty map", () => {
    expect(computeDisplayNames([], opts).size).toBe(0);
  });

  test("undefined / null input returns empty map", () => {
    expect(computeDisplayNames(undefined, opts).size).toBe(0);
    expect(computeDisplayNames(null as unknown as Row[], opts).size).toBe(0);
  });

  test("single unique row is unchanged", () => {
    const m = computeDisplayNames(
      [{ name: "a", provider_name: "Memorial Hospital" }],
      opts,
    );
    expect(m.get("a")).toBe("Memorial Hospital");
  });

  test("two same-name rows: oldest keeps bare name, newest gets (1)", () => {
    const m = computeDisplayNames(
      [
        { name: "newer", provider_name: "Memorial Hospital" },
        { name: "older", provider_name: "Memorial Hospital" },
      ],
      opts,
    );
    expect(m.get("older")).toBe("Memorial Hospital");
    expect(m.get("newer")).toBe("Memorial Hospital (1)");
  });

  test("three same-name rows assign (1) and (2) to the newer two", () => {
    const m = computeDisplayNames(
      [
        { name: "n1", provider_name: "Memorial Hospital" },
        { name: "n2", provider_name: "Memorial Hospital" },
        { name: "n3", provider_name: "Memorial Hospital" },
      ],
      opts,
    );
    expect(m.get("n3")).toBe("Memorial Hospital");
    expect(m.get("n2")).toBe("Memorial Hospital (1)");
    expect(m.get("n1")).toBe("Memorial Hospital (2)");
  });

  test("dupes interleaved with unrelated rows still suffix correctly", () => {
    const m = computeDisplayNames(
      [
        { name: "a", provider_name: "Memorial Hospital" },
        { name: "b", provider_name: "City Clinic" },
        { name: "c", provider_name: "Memorial Hospital" },
        { name: "d", provider_name: "Verizon" },
        { name: "e", provider_name: "Memorial Hospital" },
      ],
      opts,
    );
    expect(m.get("e")).toBe("Memorial Hospital");
    expect(m.get("c")).toBe("Memorial Hospital (1)");
    expect(m.get("a")).toBe("Memorial Hospital (2)");
    expect(m.get("b")).toBe("City Clinic");
    expect(m.get("d")).toBe("Verizon");
  });

  test("case-insensitive grouping; preserves the original casing", () => {
    const m = computeDisplayNames(
      [
        { name: "newer", provider_name: "memorial hospital" },
        { name: "older", provider_name: "Memorial Hospital" },
      ],
      opts,
    );
    expect(m.get("older")).toBe("Memorial Hospital");
    expect(m.get("newer")).toBe("memorial hospital (1)");
  });

  test("trailing whitespace doesn't split groups; preserved on render", () => {
    const m = computeDisplayNames(
      [
        { name: "newer", provider_name: "Memorial Hospital " },
        { name: "older", provider_name: "Memorial Hospital" },
      ],
      opts,
    );
    expect(m.get("older")).toBe("Memorial Hospital");
    // Trailing space is trimmed for the suffix anchor; we render the trimmed form.
    expect(m.get("newer")).toBe("Memorial Hospital (1)");
  });

  test("null / empty / 'Unknown provider' are NOT suffixed even when repeated", () => {
    const m = computeDisplayNames(
      [
        { name: "a", provider_name: null },
        { name: "b", provider_name: null },
        { name: "c", provider_name: "" },
        { name: "d", provider_name: "Unknown provider" },
        { name: "e", provider_name: "unknown PROVIDER" },
      ],
      opts,
    );
    expect(m.get("a")).toBe(null);
    expect(m.get("b")).toBe(null);
    expect(m.get("c")).toBe("");
    expect(m.get("d")).toBe("Unknown provider");
    expect(m.get("e")).toBe("unknown PROVIDER");
  });

  test("dupes mixed with placeholders only suffix the real names", () => {
    const m = computeDisplayNames(
      [
        { name: "newer", provider_name: "Memorial Hospital" },
        { name: "ph1", provider_name: null },
        { name: "older", provider_name: "Memorial Hospital" },
      ],
      opts,
    );
    expect(m.get("older")).toBe("Memorial Hospital");
    expect(m.get("newer")).toBe("Memorial Hospital (1)");
    expect(m.get("ph1")).toBe(null);
  });
});

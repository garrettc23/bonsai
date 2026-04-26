/**
 * Probability gate for the opportunities feature.
 *
 * The OPPS_TOOL schema requires every opportunity to declare a probability
 * (0.0–1.0) of actually reducing the charge. The server filters anything
 * below PROBABILITY_FLOOR before it ever reaches the client; the client
 * mirrors the same predicate as belt-and-braces. These tests pin the
 * schema shape, the filter behavior, and verify shipped fixtures still
 * pass the gate.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPPS_TOOL, PROBABILITY_FLOOR, filterByProbability } from "../src/opps-filter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

describe("OPPS_TOOL schema", () => {
  const itemSchema = (OPPS_TOOL.input_schema as any).properties.opportunities.items;

  test("requires opp_id, probability, and the existing core fields", () => {
    expect(itemSchema.required).toEqual(
      expect.arrayContaining(["opp_id", "title", "description", "dollar_estimate", "icon", "probability"]),
    );
  });

  test("probability is a 0..1 number", () => {
    expect(itemSchema.properties.probability.type).toBe("number");
    expect(itemSchema.properties.probability.minimum).toBe(0);
    expect(itemSchema.properties.probability.maximum).toBe(1);
  });

  test("opp_id is a string", () => {
    expect(itemSchema.properties.opp_id.type).toBe("string");
  });

  test("PROBABILITY_FLOOR is 0.5", () => {
    expect(PROBABILITY_FLOOR).toBe(0.5);
  });
});

describe("filterByProbability", () => {
  test("drops items below the floor", () => {
    const opps = [
      { id: "a", probability: 0 },
      { id: "b", probability: 0.49 },
      { id: "c", probability: 0.5 },
      { id: "d", probability: 0.7 },
      { id: "e", probability: 1 },
    ];
    expect(filterByProbability(opps).map((o) => o.id)).toEqual(["c", "d", "e"]);
  });

  test("drops items missing or non-numeric probability", () => {
    const opps = [
      { id: "missing" } as { id: string; probability?: number },
      { id: "null", probability: null as unknown as number },
      { id: "nan", probability: Number.NaN },
      { id: "string", probability: "0.9" as unknown as number },
      { id: "ok", probability: 0.6 },
    ];
    expect(filterByProbability(opps).map((o) => o.id)).toEqual(["ok"]);
  });

  test("preserves order and identity for kept items", () => {
    const a = { id: "a", probability: 0.6 };
    const b = { id: "b", probability: 0.9 };
    const c = { id: "c", probability: 0.2 };
    const out = filterByProbability([a, b, c]);
    expect(out).toEqual([a, b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  test("empty input returns empty array", () => {
    expect(filterByProbability([])).toEqual([]);
  });
});

describe("shipped fixtures pass the gate", () => {
  test("fixtures/bill-001.opportunities.json all clear PROBABILITY_FLOOR with opp_id", () => {
    const raw = readFileSync(join(ROOT, "fixtures", "bill-001.opportunities.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      opportunities: Array<{ opp_id?: string; probability?: number }>;
    };
    expect(parsed.opportunities.length).toBeGreaterThanOrEqual(3);
    for (const opp of parsed.opportunities) {
      expect(typeof opp.opp_id).toBe("string");
      expect(opp.opp_id!.length).toBeGreaterThan(0);
      expect(typeof opp.probability).toBe("number");
      expect(opp.probability!).toBeGreaterThanOrEqual(PROBABILITY_FLOOR);
    }
    // And the filter should keep all of them.
    expect(filterByProbability(parsed.opportunities)).toHaveLength(parsed.opportunities.length);
  });
});

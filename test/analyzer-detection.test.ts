/**
 * Tests for the analyzer's detection-acceptance gate — the judgment that
 * makes a finding trustworthy. Bonsai's whole promise is "every error it
 * claims is real and quoted from your bill." That promise lives in two
 * places, both exercised here:
 *
 *   1. executeRecordError (src/tools/record-error.ts) — the pure gate that
 *      validates schema, enforces the confidence rubric, checks grounding,
 *      and dedups. Deterministic, no network.
 *   2. analyze() loop (src/analyzer.ts) — wires accepted errors into the
 *      result, surfaces grounding failures, and computes the overlap-aware
 *      summary. Tested with a scripted Anthropic client (no network).
 *
 * A real-model detection eval is included at the bottom, gated on
 * ANTHROPIC_API_KEY (skipped by default — it costs money and is
 * non-deterministic; it belongs in an eval lane, not the unit suite).
 *
 * Run: bun test test/analyzer-detection.test.ts
 */
import { describe, expect, test } from "bun:test";
import { analyze } from "../src/analyzer.ts";
import { executeRecordError } from "../src/tools/record-error.ts";
import { loadGroundTruth } from "../src/lib/ground-truth.ts";
import { loadFixtureAnalyzeInput } from "../src/lib/fixture-audit.ts";
import {
  mockAnthropic,
  fullMetadataInput,
  VALID_DUPLICATE,
  type MockResponse,
} from "./helpers/mock-anthropic.ts";

const truth = loadGroundTruth("bill-001");

type RecordErrorInput = {
  line_quote: string;
  page_number: number;
  error_type: string;
  confidence: string;
  dollar_impact: number;
  evidence: string;
  cpt_code?: string;
};

function rec(overrides: Partial<RecordErrorInput>): RecordErrorInput {
  return {
    line_quote: "Chest X-ray, 2 views",
    page_number: 1,
    error_type: "duplicate",
    confidence: "high",
    dollar_impact: 468,
    evidence: "Rows 2 and 3 charge CPT 71046 twice on the same date of service.",
    ...overrides,
  };
}

describe("executeRecordError — accepts grounded findings", () => {
  test("HIGH duplicate with a verbatim bill quote", () => {
    const r = executeRecordError(rec({}), truth);
    expect(r.accepted).toBe(true);
    expect(r.error?.error_type).toBe("duplicate");
  });

  test("HIGH balance_billing (no CPT anchor) grounded on the balance line", () => {
    const r = executeRecordError(
      rec({
        line_quote: "Current Balance Due",
        error_type: "balance_billing",
        dollar_impact: 3812,
        cpt_code: undefined,
        evidence: "Bill balance exceeds the EOB-stated patient responsibility.",
      }),
      truth,
    );
    expect(r.accepted).toBe(true);
  });

  test("HIGH denied_service grounded on a line item", () => {
    const r = executeRecordError(
      rec({
        line_quote: "Comprehensive Metabolic Panel",
        error_type: "denied_service",
        cpt_code: "80053",
        dollar_impact: 285,
        evidence: "EOB 'Services Not Listed Above' denied this line; bill still charges it.",
      }),
      truth,
    );
    expect(r.accepted).toBe(true);
  });

  test.each([
    ["unbundling", "Surgical Tray", "A4550", 154],
    ["overcharge", "CT Head w/o Contrast", "70450", 3820],
    ["eob_mismatch", "Complete Blood Count, Auto", "85025", 198],
    ["qty_mismatch", "Ketorolac Tromethamine 15mg IV", "J1885", 178],
  ] as const)(
    "WORTH_REVIEWING %s is accepted",
    (error_type, line_quote, cpt_code, dollar_impact) => {
      const r = executeRecordError(
        rec({
          line_quote,
          error_type,
          confidence: "worth_reviewing",
          cpt_code,
          dollar_impact,
          evidence: `Flagged as ${error_type} for review against plan policy.`,
        }),
        truth,
      );
      expect(r.accepted).toBe(true);
    },
  );
});

describe("executeRecordError — rejects bad findings", () => {
  test("confidence rubric: HIGH is rejected for a non-HIGH error type", () => {
    const r = executeRecordError(
      rec({ error_type: "unbundling", confidence: "high", line_quote: "Surgical Tray" }),
      truth,
    );
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain('confidence: "high"');
  });

  test("grounding: a fabricated line_quote is rejected", () => {
    const r = executeRecordError(
      rec({ line_quote: "Robotic Surgery Assistance Fee", evidence: "Not actually on the bill." }),
      truth,
    );
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("not found in bill");
  });

  test("dedup: the same error type + CPT cannot be recorded twice", () => {
    const first = executeRecordError(rec({ cpt_code: "71046" }), truth);
    expect(first.accepted).toBe(true);
    const second = executeRecordError(rec({ cpt_code: "71046" }), truth, [first.error!]);
    expect(second.accepted).toBe(false);
    expect(second.reason).toContain("Already recorded");
  });

  test("schema: a negative dollar_impact is rejected", () => {
    const r = executeRecordError(rec({ dollar_impact: -5 }), truth);
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("Schema validation failed");
  });

  test("schema: a too-short line_quote is rejected", () => {
    const r = executeRecordError(rec({ line_quote: "x-ray" }), truth);
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("Schema validation failed");
  });
});

// ---------------------------------------------------------------------------
// analyze() loop — scripted Anthropic client, no network.
// ---------------------------------------------------------------------------

const FABRICATED = {
  line_quote: "Robotic Surgery Assistance Fee",
  page_number: 1,
  error_type: "overcharge",
  confidence: "worth_reviewing",
  dollar_impact: 9999,
  evidence: "This line does not actually exist on the bill.",
};

async function runAnalyze(responses: MockResponse[]) {
  const input = await loadFixtureAnalyzeInput("bill-001", "eob-001");
  return analyze({
    bill: input.bill,
    eob: input.eob,
    billGroundTruth: truth,
    anthropicClient: mockAnthropic(responses),
  });
}

describe("analyze() loop", () => {
  test("records grounded errors, surfaces fabricated ones, finalizes", async () => {
    const result = await runAnalyze([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t0", name: "record_bill_metadata", input: fullMetadataInput() },
          { type: "tool_use", id: "t1", name: "record_error", input: VALID_DUPLICATE },
          { type: "tool_use", id: "t2", name: "record_error", input: FABRICATED },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: "finalize_analysis",
            input: {
              high_confidence_total: 468,
              worth_reviewing_total: 0,
              bill_total_disputed: 468,
              headline: "Found $468 in high-confidence billing errors (1 duplicate).",
            },
          },
        ],
      },
    ]);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error_type).toBe("duplicate");
    expect(result.grounding_failures.length).toBe(1);
    expect(result.grounding_failures[0].reason).toContain("not found in bill");
    expect(result.metadata.patient_name).toBe("Jane Q. Doe");
    expect(result.summary.high_confidence_total).toBe(468);
    expect(result.meta.tool_turns).toBe(2);
  });

  test("auto-computes the summary when the model never calls finalize", async () => {
    const result = await runAnalyze([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "record_error", input: VALID_DUPLICATE }],
      },
      { stop_reason: "end_turn", content: [] },
    ]);

    expect(result.errors.length).toBe(1);
    expect(result.summary.high_confidence_total).toBe(468);
    expect(result.summary.headline).toContain("auto-computed");
  });
});

// ---------------------------------------------------------------------------
// Real-model detection eval — gated, non-deterministic, costs money.
// Runs only when ANTHROPIC_API_KEY is present (CI eval lane / local opt-in).
// ---------------------------------------------------------------------------
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe("analyze() real-model eval [gated]", () => {
  test.skipIf(!HAS_KEY)(
    "detects at least one HIGH finding on bill-001 and every quote is grounded",
    async () => {
      const input = await loadFixtureAnalyzeInput("bill-001", "eob-001");
      const result = await analyze({
        bill: input.bill,
        eob: input.eob,
        billGroundTruth: input.billGroundTruth,
      });
      const high = result.errors.filter((e) => e.confidence === "high");
      expect(high.length).toBeGreaterThan(0);
      // Every reported quote must actually appear in the bill.
      for (const e of result.errors) {
        const { quoteAppearsIn } = await import("../src/lib/ground-truth.ts");
        expect(quoteAppearsIn(e.line_quote, input.billGroundTruth).found).toBe(true);
      }
    },
    120_000,
  );
});

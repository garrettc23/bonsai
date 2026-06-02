/**
 * Tests for Workstream B: the analyzer engine is now category-capable, not
 * medical-only. Covers:
 *
 *   - analyzerRulesFor() returns the right detection rule-pack per kind.
 *   - highTypesForKind() / executeRecordError() apply the non-medical
 *     HIGH-confidence rubric (and still apply the medical one by default).
 *   - analyze() with billKind="utility" + a scripted client records a
 *     grounded, category-appropriate finding via the real tool loop.
 *
 * Deterministic: scripted Anthropic client, no network.
 *
 * Run: bun test test/analyzer-rules.test.ts
 */
import { describe, expect, test } from "bun:test";
import { analyze } from "../src/analyzer.ts";
import { analyzerRulesFor } from "../src/lib/analyzer-rules.ts";
import { executeRecordError } from "../src/tools/record-error.ts";
import { highTypesForKind } from "../src/types.ts";
import { groundTruthFromText } from "../src/lib/ground-truth.ts";
import type { NormalizedBill } from "../src/lib/extract-bill.ts";
import { mockAnthropic, fullMetadataInput, type MockResponse } from "./helpers/mock-anthropic.ts";

describe("analyzerRulesFor", () => {
  test.each([
    ["utility", "utility-bill auditor"],
    ["telecom", "telecom-bill auditor"],
    ["subscription", "subscription-bill auditor"],
  ] as const)("%s pack is category-specific and keeps the grounding contract", (kind, marker) => {
    const rules = analyzerRulesFor(kind);
    expect(rules).toContain(marker);
    expect(rules).toContain("Grounding contract");
    expect(rules).toContain("unauthorized_charge");
    expect(rules).toContain("There is NO EOB");
  });

  test.each(["insurance", "financial", "other"] as const)(
    "%s falls back to the generic non-medical pack",
    (kind) => {
      expect(analyzerRulesFor(kind)).toContain("general bill auditor");
    },
  );
});

describe("highTypesForKind / rubric", () => {
  test("medical keeps its EOB-grounded HIGH set", () => {
    expect(highTypesForKind("medical")).toEqual(["duplicate", "denied_service", "balance_billing"]);
  });

  test("non-medical kinds share the bill-grounded HIGH set", () => {
    expect(highTypesForKind("utility")).toEqual(["duplicate", "unauthorized_charge", "expired_promo"]);
    expect(highTypesForKind("subscription")).toEqual(highTypesForKind("telecom"));
  });
});

describe("executeRecordError — non-medical rubric", () => {
  const truth = groundTruthFromText(
    "Streaming Add-On Premium .................... $14.99\nPaperless Convenience Fee ........ $2.00\nLate Fee ........ $9.00",
    "utility://acct-1",
  );

  function rec(over: Record<string, unknown>) {
    return {
      line_quote: "Streaming Add-On Premium",
      page_number: 1,
      error_type: "unauthorized_charge",
      confidence: "high",
      dollar_impact: 14.99,
      evidence: "Customer never subscribed to this streaming add-on.",
      ...over,
    };
  }

  test("unauthorized_charge HIGH is accepted for a utility bill", () => {
    const r = executeRecordError(rec({}), truth, [], "utility");
    expect(r.accepted).toBe(true);
  });

  test("a medical-only HIGH type (denied_service) is rejected for a utility bill", () => {
    const r = executeRecordError(
      rec({ error_type: "denied_service", line_quote: "Paperless Convenience Fee" }),
      truth,
      [],
      "utility",
    );
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("utility bill");
  });

  test("fee_waiver cannot be HIGH (worth_reviewing only)", () => {
    const r = executeRecordError(
      rec({ error_type: "fee_waiver", line_quote: "Late Fee", confidence: "high", dollar_impact: 9 }),
      truth,
      [],
      "utility",
    );
    expect(r.accepted).toBe(false);
  });
});

describe("analyze() — category rule-pack via the tool loop", () => {
  function minimalBill(): NormalizedBill {
    // The scripted client ignores the bill content; grounding is checked
    // against billGroundTruth below.
    return { kind: "document", mediaType: "application/pdf", base64: "", originalName: "telecom.pdf", transcoded: false };
  }

  test("a telecom bill records a grounded unauthorized_charge as HIGH", async () => {
    const truth = groundTruthFromText(
      "Account 555-22\nDevice Protection Plan ........ $12.00\nIntl Roaming Pass (unused) ........ $40.00",
      "telecom://x",
    );
    const responses: MockResponse[] = [
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t0", name: "record_bill_metadata", input: { ...fullMetadataInput(), bill_kind: "telecom" } },
          {
            type: "tool_use",
            id: "t1",
            name: "record_error",
            input: {
              line_quote: "Device Protection Plan",
              page_number: 1,
              error_type: "unauthorized_charge",
              confidence: "high",
              dollar_impact: 12,
              evidence: "Customer never enrolled in device protection.",
            },
          },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "finalize_analysis",
            input: {
              high_confidence_total: 12,
              worth_reviewing_total: 0,
              bill_total_disputed: 12,
              headline: "Found $12 in unauthorized telecom charges.",
            },
          },
        ],
      },
    ];

    const result = await analyze({
      bill: minimalBill(),
      billGroundTruth: truth,
      billKind: "telecom",
      anthropicClient: mockAnthropic(responses),
    });

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error_type).toBe("unauthorized_charge");
    expect(result.errors[0].confidence).toBe("high");
    expect(result.summary.high_confidence_total).toBe(12);
  });
});

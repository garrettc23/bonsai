/**
 * `record_error` — the tool Claude calls once per billing error it finds.
 *
 * The input_schema is derived from the zod BillingError schema but flattened
 * for JSON Schema. Claude gets strong guidance here — enum values for
 * error_type and confidence, minimum lengths on line_quote/evidence, etc.
 *
 * The handler (wired up in analyzer.ts) validates line_quote against the
 * bill ground truth and rejects with a helpful error message on miss, so
 * Claude can self-correct on the next turn.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { BillingError, HIGH_CONFIDENCE_TYPES, type ErrorType, type Confidence } from "../types.ts";
import { quoteAppearsIn, type GroundTruth } from "../lib/ground-truth.ts";

export const RECORD_ERROR_TOOL: Anthropic.Tool = {
  name: "record_error",
  description:
    "Record one billing error you have identified. Call this once per distinct error. Every field is required except cpt_code. line_quote MUST be a verbatim quote from the itemized hospital bill — not the EOB, not a paraphrase. If you cannot find a verbatim quote, do not call this tool.",
  input_schema: {
    type: "object",
    required: ["line_quote", "page_number", "error_type", "confidence", "dollar_impact", "evidence"],
    properties: {
      line_quote: {
        type: "string",
        minLength: 8,
        description:
          "Verbatim quote of the bill line(s) at issue. Copy the text exactly as it appears in the itemized hospital bill. For table rows, include the whole row. Minimum 8 characters.",
      },
      page_number: {
        type: "integer",
        minimum: 1,
        description: "1-indexed page of the bill where line_quote appears.",
      },
      error_type: {
        type: "string",
        enum: [
          "duplicate",
          "denied_service",
          "balance_billing",
          "unbundling",
          "qty_mismatch",
          "eob_mismatch",
          "overcharge",
        ],
        description:
          "Type of error. duplicate = same CPT+date billed twice. denied_service = EOB explicitly denied this line but bill still charges patient. balance_billing = patient being charged more than EOB's stated patient responsibility (especially from in-network providers). unbundling = line should have been included in facility fee or procedure bundle. qty_mismatch = bill quantity differs from EOB quantity. eob_mismatch = non-denial discrepancy between bill and EOB allowed amount. overcharge = above a market benchmark (e.g. Medicare PFS) with no EOB/duplicate/balance-billing signal.",
      },
      confidence: {
        type: "string",
        enum: ["high", "worth_reviewing"],
        description:
          "Confidence tier. HIGH = duplicate, denied_service, or balance_billing (these are defensible with direct EOB evidence). WORTH_REVIEWING = everything else (eob_mismatch, unbundling, qty_mismatch, overcharge). The rubric is strict: if error_type is not one of {duplicate, denied_service, balance_billing}, confidence MUST be worth_reviewing.",
      },
      dollar_impact: {
        type: "number",
        minimum: 0,
        description:
          "Dollars the patient should not owe for this finding. Use the conservative amount if there is ambiguity. Do not inflate by counting overlapping amounts twice — if a balance-billing finding already subsumes individual line items, report the individual-line dollar_impact at the individual level and note the overlap in evidence.",
      },
      evidence: {
        type: "string",
        minLength: 10,
        description:
          "Why this is an error. Cite the specific EOB section or cross-reference that justifies the finding, e.g. 'EOB Services Not Listed Above states: Duplicate charge for CPT 71046 — already paid once.' Include verbatim EOB quotes when possible.",
      },
      cpt_code: {
        type: "string",
        description:
          "Optional CPT or HCPCS code for this line. Omit for errors that have no single CPT anchor (e.g. balance_billing on the bill total).",
      },
    },
  },
};

export interface RecordErrorInput {
  line_quote: string;
  page_number: number;
  error_type: ErrorType;
  confidence: Confidence;
  dollar_impact: number;
  evidence: string;
  cpt_code?: string;
}

export interface RecordErrorResult {
  accepted: boolean;
  error?: BillingError;
  reason?: string;
}

/**
 * Execute the record_error tool call.
 *   - Validates shape with zod.
 *   - Enforces the confidence rubric: high tier is reserved for
 *     duplicate/denied_service/balance_billing only.
 *   - Validates line_quote against bill ground truth.
 */
export function executeRecordError(
  input: unknown,
  billGroundTruth: GroundTruth,
): RecordErrorResult {
  const parsed = BillingError.safeParse(input);
  if (!parsed.success) {
    return {
      accepted: false,
      reason: `Schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  const err = parsed.data;

  // Confidence rubric enforcement.
  if (err.confidence === "high" && !HIGH_CONFIDENCE_TYPES.includes(err.error_type)) {
    return {
      accepted: false,
      reason: `confidence: "high" is only allowed for error_type in {duplicate, denied_service, balance_billing}. You reported error_type: "${err.error_type}" which must be confidence: "worth_reviewing". Re-call record_error with the corrected confidence.`,
    };
  }

  // Grounding check.
  const grounding = quoteAppearsIn(err.line_quote, billGroundTruth);
  if (!grounding.found) {
    return {
      accepted: false,
      reason: grounding.reason ?? "line_quote not grounded in bill",
    };
  }

  return { accepted: true, error: err };
}

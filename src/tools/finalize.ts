/**
 * `finalize_analysis` — the tool Claude calls exactly once at the end.
 *
 * Commits the summary totals and headline. If Claude returns end_turn
 * without calling this, the analyzer computes a summary from the
 * recorded errors as a fallback.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { AnalysisSummary } from "../types.ts";

export const FINALIZE_TOOL: Anthropic.Tool = {
  name: "finalize_analysis",
  description:
    "Call this exactly once at the end of your analysis, after you have recorded every error with record_error. Commits your summary totals and a one-sentence headline the UI will display. Only call this AFTER you are done calling record_error.",
  input_schema: {
    type: "object",
    required: ["high_confidence_total", "worth_reviewing_total", "bill_total_disputed", "headline"],
    properties: {
      high_confidence_total: {
        type: "number",
        minimum: 0,
        description:
          "Sum of dollar_impact across HIGH-confidence errors. This is the headline dollar number. If errors overlap (e.g. balance billing subsumes individual lines), report the NON-OVERLAPPING defensible total, not the naive sum.",
      },
      worth_reviewing_total: {
        type: "number",
        minimum: 0,
        description:
          "Sum of dollar_impact across WORTH_REVIEWING errors. Surfaced in UI but not sent to the billing department.",
      },
      bill_total_disputed: {
        type: "number",
        minimum: 0,
        description:
          "Total dollars disputed across all errors, de-duplicated. This is what a reasonable appeal would ask the billing department to correct.",
      },
      headline: {
        type: "string",
        minLength: 10,
        description:
          "One sentence summary the UI will display, e.g. 'Found $3,812 in high-confidence billing errors, primarily balance billing from an in-network provider.' Be specific about the dollar figure and the dominant error type.",
      },
    },
  },
};

export interface FinalizeInput {
  high_confidence_total: number;
  worth_reviewing_total: number;
  bill_total_disputed: number;
  headline: string;
}

export function parseFinalize(input: unknown): AnalysisSummary | null {
  const parsed = AnalysisSummary.safeParse(input);
  return parsed.success ? parsed.data : null;
}

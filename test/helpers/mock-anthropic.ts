/**
 * Shared test helper: a scripted Anthropic client and the canned tool-call
 * payloads the analyzer expects. Used by analyzer-detection.test.ts and
 * orchestrator-e2e.test.ts so the audit path is deterministic and free.
 *
 * The analyzer reads response.content, response.stop_reason, and
 * response.usage.{input,output}_tokens — the helper stamps usage on every
 * scripted response so the loop's token accounting doesn't throw.
 */
import type Anthropic from "@anthropic-ai/sdk";

export interface MockResponse {
  stop_reason: "end_turn" | "tool_use";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
}

export function mockAnthropic(responses: MockResponse[]): Anthropic {
  const queue = [...responses];
  return {
    messages: {
      create: async () => {
        const next = queue.shift();
        if (!next) throw new Error("mock analyzer client: no more scripted responses");
        return { ...next, usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  } as unknown as Anthropic;
}

/** Full BillMetadata payload — every field present (nulls allowed). */
export function fullMetadataInput(): Record<string, unknown> {
  return {
    patient_name: "Jane Q. Doe",
    provider_name: "ST. SYNTHETIC REGIONAL HOSPITAL",
    provider_billing_address: null,
    claim_number: null,
    date_of_service: "03/14/2026",
    insurer_name: null,
    eob_patient_responsibility: null,
    bill_current_balance_due: 6371.5,
    account_number: "2045-887291",
    bill_kind: "medical",
  };
}

/** A grounded duplicate finding for fixture bill-001 (CPT 71046, rows 2 & 3). */
export const VALID_DUPLICATE = {
  line_quote: "Chest X-ray, 2 views",
  page_number: 1,
  error_type: "duplicate",
  confidence: "high",
  dollar_impact: 468,
  evidence: "CPT 71046 charged on rows 2 and 3, same date of service.",
  cpt_code: "71046",
};

/** A scripted two-turn analyzer run: metadata + one duplicate, then finalize. */
export function scriptOneDuplicateThenFinalize(): MockResponse[] {
  return [
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t0", name: "record_bill_metadata", input: fullMetadataInput() },
        { type: "tool_use", id: "t1", name: "record_error", input: VALID_DUPLICATE },
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
            high_confidence_total: 468,
            worth_reviewing_total: 0,
            bill_total_disputed: 468,
            headline: "Found $468 in high-confidence billing errors (1 duplicate).",
          },
        },
      ],
    },
  ];
}

/**
 * Bonsai analyzer — reads a bill (and optionally an EOB), produces
 * structured errors.
 *
 * Control flow:
 *   1. Send the system prompt + bill (+ optional EOB) to Claude, with two
 *      tools available: record_error, finalize_analysis.
 *   2. Loop on tool_use stop_reason:
 *      - For each record_error call, validate shape and grounding.
 *        Accepted → keep in errors[]. Rejected → tool_result with reason;
 *        Claude self-corrects.
 *      - For finalize_analysis, capture the summary and break.
 *   3. If Claude hits end_turn without finalize, compute a summary from
 *      the accepted errors.
 *
 * The grounding check (line_quote must appear in the bill's ground-truth
 * text) is the whole point. For shipped fixtures the ground truth comes
 * from `fixtures/*.md`. For live uploads it comes from a pre-flight
 * transcription call (see `src/lib/transcribe-bill.ts`). Either way this
 * module just consumes a `GroundTruth` and doesn't care which.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { GroundTruth } from "./lib/ground-truth.ts";
import type { NormalizedBill } from "./lib/extract-bill.ts";
import {
  RECORD_ERROR_TOOL,
  executeRecordError,
  type RecordErrorResult,
} from "./tools/record-error.ts";
import { FINALIZE_TOOL, parseFinalize } from "./tools/finalize.ts";
import {
  RECORD_METADATA_TOOL,
  parseMetadata,
  emptyMetadata,
} from "./tools/record-metadata.ts";
import type {
  AnalyzerResult,
  BillingError,
  BillMetadata,
  AnalysisSummary,
} from "./types.ts";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 4096;
const MAX_TOOL_TURNS = 30;

const SYSTEM_PROMPT_WITH_EOB = `You are Bonsai, a medical billing auditor. You are shown two documents:

1. An itemized hospital bill (what the provider is charging the patient).
2. An EOB (Explanation of Benefits) from the patient's insurance plan — what the insurer allowed, paid, denied, and calculated as the patient's true responsibility.

Your job: identify every billing error in the bill, using the EOB as the ground-truth cross-reference.

## Tool-call order (strict)

1. FIRST, call record_bill_metadata exactly once with bill/EOB metadata (patient, provider, claim #, dollar totals). Any field you cannot confidently find → return null. Do NOT invent values; a null becomes a user-editable placeholder in the appeal letter. Inventing a billing address is worse than none.
2. THEN call record_error once per distinct error you find.
3. FINALLY call finalize_analysis exactly once. Then stop.

## Error types (pick the most specific)

- duplicate: Same CPT+date charged twice in the bill.
- denied_service: EOB explicitly denied or rejected the line (e.g. in a "Services Not Listed Above" section), but the bill still charges the patient.
- balance_billing: The bill's current-balance-due exceeds the EOB's stated patient responsibility, especially for in-network providers. The classic pattern: the provider tries to pass the contractual network-discount write-off to the patient.
- unbundling: A line that plan policy requires to be bundled into a facility fee or procedure (surgical trays, non-prescription meds, standard supplies).
- qty_mismatch: Units on the bill differ from units on the EOB.
- eob_mismatch: Bill-line amount differs from EOB allowed amount, with no outright denial.
- overcharge: Above a market benchmark (Medicare PFS). LOW-signal — prefer one of the above if applicable.

## Confidence rubric (strict)

- HIGH is reserved for: duplicate, denied_service, balance_billing. These are the errors Bonsai can defend with direct EOB evidence and will escalate to the billing department.
- WORTH_REVIEWING is everything else. These surface in the UI but will not be sent to a billing department.

If you report error_type = duplicate / denied_service / balance_billing, set confidence = "high". For anything else, confidence = "worth_reviewing". The tool will reject invalid combinations.

## Grounding contract — CRITICAL

Every record_error call MUST include a line_quote that is a verbatim copy of text from the BILL (not the EOB, not a paraphrase). Include the whole row for table rows. If the grounding check fails, the tool will tell you the quote wasn't found; re-call record_error with the exact bill text.

## Dollar figures — read carefully, this is where it goes wrong

- dollar_impact on each record_error is the amount the patient should NOT owe for THAT specific finding, taken in isolation.
- finalize_analysis totals must NOT double-count overlaps. The #1 mistake is summing line-item denials + a balance_billing finding that already subsumes them. Example of what NOT to do:

  * You record 5 denied_service errors totaling $3,590 (all reflect amounts the EOB already excluded from the patient's responsibility).
  * You record 1 balance_billing error of $3,812 (the bill charges $3,812 more than the EOB's stated patient responsibility, which mechanically INCLUDES the 5 denied amounts above).
  * WRONG: high_confidence_total = $3,590 + $3,812 = $7,402.
  * RIGHT: high_confidence_total = $3,812 (balance_billing is the envelope; the denials explain WHY, but they're already inside that envelope).

- Rule: if a balance_billing finding exists, the defensible total is MAX(balance_billing.dollar_impact, sum of non-balance-billing HIGH errors) — NOT their sum. bill_total_disputed follows the same rule.
- If no balance_billing finding exists, totals can be summed normally.

## Process

1. Read both documents carefully. Cross-reference every bill line against the EOB.
2. Call record_bill_metadata ONCE with all bill/EOB metadata fields (nulls allowed).
3. For each distinct error, call record_error. Emit ALL record_error calls in PARALLEL in one turn — make every tool call at once inside the same assistant message rather than one per turn. This cuts latency dramatically.
4. After the last record_error, call finalize_analysis once. Then stop.

Do not include prose commentary. The tool calls are your entire output.`;

const SYSTEM_PROMPT_BILL_ONLY = `You are Bonsai, a medical billing auditor. You are shown a single itemized hospital bill. NO EOB (Explanation of Benefits) was provided.

Your job: identify every billing error you can defend from the bill alone, and flag items a typical insurance plan would likely adjust.

## Tool-call order (strict)

1. FIRST, call record_bill_metadata exactly once. For bill-side fields (patient, provider, bill_total, bill_current_balance_due, date_of_service) use values you can read on the bill. For EOB-side fields (eob_* anything) return null — you do not have an EOB. Do NOT invent values.
2. THEN call record_error once per distinct error you find.
3. FINALLY call finalize_analysis exactly once. Then stop.

## Error types (pick the most specific)

- duplicate: Same CPT+date charged twice in the bill. This is the only HIGH-confidence error type available without an EOB.
- unbundling: A line that plan policy requires to be bundled into a facility fee or procedure (surgical trays, non-prescription meds, OTC meds, standard supplies, routine kits). Flag these as WORTH_REVIEWING.
- overcharge: Line item whose dollar amount is clearly above a market benchmark (e.g. Medicare PFS). Use sparingly. WORTH_REVIEWING.
- eob_mismatch / qty_mismatch / denied_service / balance_billing: Do NOT use these without an EOB — you have no ground-truth reference for them.

## Confidence rubric (strict)

- HIGH is reserved for duplicate only when you can point to two rows of the bill with the same CPT+date.
- WORTH_REVIEWING for unbundling and overcharge. These surface in the UI but will not be sent to a billing department on their own.

The tool will reject any HIGH-confidence finding that isn't a duplicate.

## Grounding contract — CRITICAL

Every record_error call MUST include a line_quote that is a verbatim copy of text from the bill (not a paraphrase). Include the whole row for table rows. If the grounding check fails, the tool will tell you the quote wasn't found; re-call record_error with the exact bill text.

## Dollar figures

- dollar_impact on each record_error is the amount the patient should NOT owe for that finding.
- finalize_analysis totals: sum all HIGH for high_confidence_total, sum all WORTH_REVIEWING for worth_reviewing_total, and bill_total_disputed = high_confidence_total (no balance-billing envelope math applies without an EOB).

## Process

1. Read the bill carefully. Scan the itemized charges for duplicates and bundled/non-covered items.
2. Call record_bill_metadata ONCE with all fields (nulls allowed; EOB fields must be null).
3. For each distinct error, call record_error. Emit ALL record_error calls in PARALLEL in one turn — make every tool call at once inside the same assistant message rather than one per turn. This cuts latency dramatically.
4. After the last record_error, call finalize_analysis once. Then stop.

Do not include prose commentary. The tool calls are your entire output.`;

/**
 * Overlap-aware total for HIGH-confidence findings.
 *
 * Balance billing is an envelope: the bill's patient-facing total exceeds
 * the EOB's stated patient responsibility, by exactly the sum of
 * (disallowed items + improperly passed-through network discount + any
 * other denied lines). Summing balance_billing + individual line items
 * double-counts.
 *
 * Rule:
 *   - If any balance_billing error exists, defensible = max(balance_billing,
 *     sum of non-balance-billing HIGH).
 *   - Otherwise, defensible = sum of HIGH.
 */
export function computeDefensibleTotal(errors: BillingError[]): number {
  const high = errors.filter((e) => e.confidence === "high");
  const bb = high.filter((e) => e.error_type === "balance_billing");
  const nonBb = high.filter((e) => e.error_type !== "balance_billing");
  const nonBbTotal = nonBb.reduce((a, e) => a + e.dollar_impact, 0);
  if (bb.length === 0) return nonBbTotal;
  // If multiple balance_billing findings, take the largest (they're all envelopes).
  const bbMax = Math.max(...bb.map((e) => e.dollar_impact));
  return Math.max(bbMax, nonBbTotal);
}

export interface AnalyzeOptions {
  /**
   * Normalized bill ready to embed in a Claude message. Single file or an
   * ordered array of pages/photos — all are shown to the model together as
   * one bill.
   */
  bill: NormalizedBill | NormalizedBill[];
  /** Normalized EOB. When omitted, analyzer runs in bill-only mode. */
  eob?: NormalizedBill;
  /** Ground truth text for line_quote validation. */
  billGroundTruth: GroundTruth;
  anthropicClient?: Anthropic;
}

function billContentBlock(
  bill: NormalizedBill,
  title: string,
  context: string,
): Anthropic.Messages.ContentBlockParam {
  if (bill.kind === "document") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: bill.base64 },
      title,
      context,
    };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: bill.mediaType, data: bill.base64 },
  };
}

export async function analyze(opts: AnalyzeOptions): Promise<AnalyzerResult> {
  const client = opts.anthropicClient ?? new Anthropic();
  const billGroundTruth = opts.billGroundTruth;
  const hasEob = !!opts.eob;
  const bills = Array.isArray(opts.bill) ? opts.bill : [opts.bill];

  const t0 = Date.now();
  const errors: BillingError[] = [];
  const groundingFailures: AnalyzerResult["grounding_failures"] = [];
  let summary: AnalysisSummary | null = null;
  let metadata: BillMetadata | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolTurns = 0;

  const userContent: Anthropic.Messages.ContentBlockParam[] = [];
  bills.forEach((b, i) => {
    const title =
      bills.length === 1
        ? "Itemized Hospital Bill"
        : `Itemized Hospital Bill — page ${i + 1} of ${bills.length}`;
    const context =
      bills.length === 1
        ? "The provider's charges. Treat every line as referenceable for line_quote."
        : `Bill page ${i + 1}. All pages are parts of the same bill; cross-reference them and cite line_quote from any page.`;
    userContent.push(billContentBlock(b, title, context));
  });
  if (opts.eob) {
    userContent.push(
      billContentBlock(
        opts.eob,
        "Insurance EOB",
        "What the insurer allowed, paid, denied, and calculated as patient responsibility. Use this as ground truth for errors.",
      ),
    );
  }
  userContent.push({
    type: "text",
    text: hasEob
      ? "Audit this bill against the EOB. Call record_error for each error you find, then finalize_analysis once at the end."
      : "No EOB was provided. Audit the bill alone for duplicates and items a typical plan would bundle or not cover. Call record_error for each finding, then finalize_analysis once at the end.",
  });

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: hasEob ? SYSTEM_PROMPT_WITH_EOB : SYSTEM_PROMPT_BILL_ONLY,
      tools: [RECORD_METADATA_TOOL, RECORD_ERROR_TOOL, FINALIZE_TOOL],
      messages,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    toolTurns = turn + 1;

    // Add assistant response to the transcript.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      if (toolUseBlocks.length === 0) break;

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      let finalized = false;

      for (const block of toolUseBlocks) {
        if (block.name === "record_error") {
          const result: RecordErrorResult = executeRecordError(block.input, billGroundTruth, errors);
          if (result.accepted && result.error) {
            errors.push(result.error);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Accepted. Error #${errors.length} recorded: ${result.error.error_type} (${result.error.confidence}, $${result.error.dollar_impact}).`,
            });
          } else {
            groundingFailures.push({
              attempted_error: (block.input ?? {}) as Partial<BillingError>,
              reason: result.reason ?? "unknown",
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `REJECTED: ${result.reason}. Do not re-submit this error as-is; either correct the issue or skip it.`,
              is_error: true,
            });
          }
        } else if (block.name === "record_bill_metadata") {
          const parsed = parseMetadata(block.input);
          if (parsed.success) {
            metadata = parsed.data;
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "Bill metadata recorded. Now proceed with record_error calls.",
            });
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `REJECTED: record_bill_metadata input failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Every field is required; use null (not omitted) for unknowns.`,
              is_error: true,
            });
          }
        } else if (block.name === "finalize_analysis") {
          const parsed = parseFinalize(block.input);
          if (parsed) {
            summary = parsed;
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "Analysis finalized. Thank you.",
            });
            finalized = true;
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "REJECTED: finalize_analysis input failed schema validation. All four fields (high_confidence_total, worth_reviewing_total, bill_total_disputed, headline) are required.",
              is_error: true,
            });
          }
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      if (finalized) break;
    } else {
      // stop_reason is something unexpected (max_tokens, etc). Stop.
      break;
    }
  }

  // Compute the defensible (overlap-aware) total independently of Claude.
  // If a balance_billing finding exists, total = max(balance_billing, sum of
  // other HIGH); otherwise sum all HIGH.
  const defensibleTotal = computeDefensibleTotal(errors);

  if (!summary) {
    const high = errors.filter((e) => e.confidence === "high");
    const worth = errors.filter((e) => e.confidence === "worth_reviewing");
    const worthTotal = worth.reduce((a, e) => a + e.dollar_impact, 0);
    summary = {
      high_confidence_total: defensibleTotal,
      worth_reviewing_total: worthTotal,
      bill_total_disputed: defensibleTotal,
      headline: high.length
        ? `Found $${defensibleTotal.toFixed(2)} in high-confidence billing errors across ${high.length} findings. (Summary auto-computed; Claude did not call finalize_analysis.)`
        : "No high-confidence errors found.",
    };
  } else {
    // Claude called finalize. Sanity-check its total against ours; if the
    // claimed total is >5% off the defensible total, override and flag.
    const claimed = summary.high_confidence_total;
    const drift = Math.abs(claimed - defensibleTotal);
    const tolerance = Math.max(defensibleTotal * 0.05, 10);
    if (drift > tolerance) {
      summary = {
        ...summary,
        high_confidence_total: defensibleTotal,
        bill_total_disputed: defensibleTotal,
        headline: `${summary.headline} [auto-corrected: Claude reported $${claimed.toFixed(2)} but defensible total is $${defensibleTotal.toFixed(2)} due to balance-billing overlap with line items.]`,
      };
    }
  }

  return {
    metadata: metadata ?? emptyMetadata(),
    errors,
    summary,
    grounding_failures: groundingFailures,
    meta: {
      model: MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      elapsed_ms: Date.now() - t0,
      tool_turns: toolTurns,
    },
  };
}

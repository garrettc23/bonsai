/**
 * Bonsai error schema — the grounding contract.
 *
 * Every error Claude reports must:
 *   - quote a verbatim line from the bill (line_quote)
 *   - name its page number
 *   - commit to a confidence tier and error type
 *   - justify itself with EOB evidence
 *
 * line_quote is the primary anchor. cpt_code is optional because some
 * errors (balance billing, qty mismatch) have no single CPT row.
 */
import { z } from "zod";

export const ErrorType = z.enum([
  "duplicate",          // Same CPT+date charged twice in the bill
  "denied_service",     // EOB explicitly denied this line; bill still charges
  "balance_billing",    // Bill's patient portion exceeds EOB's stated responsibility
  "unbundling",         // Line should have been bundled into facility fee
  "qty_mismatch",       // Quantity on bill doesn't match EOB quantity
  "eob_mismatch",       // Bill line amount differs from EOB allowed amount (non-denial)
  "overcharge",         // Above market benchmark (e.g. Medicare PFS) — low-signal only
]);
export type ErrorType = z.infer<typeof ErrorType>;

export const Confidence = z.enum(["high", "worth_reviewing"]);
export type Confidence = z.infer<typeof Confidence>;

/**
 * 2-tier confidence rubric (degraded from 3-tier per CEO plan 2026-04-22):
 *
 *   HIGH            → duplicate, denied_service, balance_billing
 *   WORTH_REVIEWING → eob_mismatch, unbundling, qty_mismatch, overcharge
 *
 * Only HIGH-confidence errors feed into negotiation (email/voice).
 * WORTH_REVIEWING surfaces in UI but is never sent to a billing department.
 */
export const HIGH_CONFIDENCE_TYPES: ErrorType[] = [
  "duplicate",
  "denied_service",
  "balance_billing",
];

export const BillingError = z.object({
  line_quote: z.string().min(8).describe(
    "Verbatim quote of the bill line(s) at issue. Must appear in the bill exactly as written. Include the whole row for table rows.",
  ),
  page_number: z.number().int().min(1).describe(
    "1-indexed page of the bill where the line_quote appears.",
  ),
  error_type: ErrorType,
  confidence: Confidence,
  dollar_impact: z.number().nonnegative().describe(
    "Dollars the patient should not owe for this finding. Use the conservative amount if ambiguous.",
  ),
  evidence: z.string().min(10).describe(
    "Why this is an error. Cite the specific EOB section or cross-reference that justifies the finding.",
  ),
  cpt_code: z.string().optional().describe(
    "Optional-but-preferred CPT or HCPCS code associated with the line.",
  ),
});
export type BillingError = z.infer<typeof BillingError>;

export const AnalysisSummary = z.object({
  high_confidence_total: z.number().nonnegative().describe(
    "Sum of dollar_impact across HIGH-confidence errors. This is the headline number.",
  ),
  worth_reviewing_total: z.number().nonnegative().describe(
    "Sum of dollar_impact across WORTH_REVIEWING errors. Surfaced in UI but not sent to billing dept.",
  ),
  bill_total_disputed: z.number().nonnegative().describe(
    "Total dollars disputed across all errors. May be less than sum-of-parts if findings overlap (e.g. balance billing subsumes individual line items).",
  ),
  headline: z.string().min(10).describe(
    "One sentence summary the UI can display, e.g. 'Found $3,812 in high-confidence billing errors, primarily balance billing from an in-network provider.'",
  ),
});
export type AnalysisSummary = z.infer<typeof AnalysisSummary>;

/**
 * Bill kind — the negotiation playbook depends on this. Medical is the
 * grounded path (analyzer findings + EOB cite); the others run in goodwill
 * mode (retention discount, hardship, fee waiver, promo restoration) until
 * we add per-kind error detection.
 */
export const BillKind = z.enum([
  "medical",
  "telecom",
  "utility",
  "subscription",
  "insurance",
  "financial",
  "other",
]);
export type BillKind = z.infer<typeof BillKind>;

/**
 * Bill-level metadata Claude extracts from the bill + EOB.
 *
 * The appeal letter generator needs these: who to address the letter to,
 * what claim to reference, what dollar amount the EOB says the patient
 * actually owes. If any field is missing Claude returns null for it — the
 * letter generator falls back to placeholders the user can fill in.
 *
 * `bill_kind` defaults to "medical" because today's analyzer only runs on
 * medical bills. For non-medical bills the analyzer is skipped and the
 * kind is set from user input on the Contact tab.
 */
export const BillMetadata = z.object({
  patient_name: z.string().nullable().describe("Patient's full name from the bill."),
  provider_name: z.string().nullable().describe("Hospital / clinic / provider name from the bill."),
  provider_billing_address: z.string().nullable().describe("Billing department address as it appears on the bill. May include address line, city, state, zip on one line."),
  claim_number: z.string().nullable().describe("Claim number from the EOB."),
  date_of_service: z.string().nullable().describe("Date of service as it appears (ISO or provider format)."),
  insurer_name: z.string().nullable().describe("Insurance company name from the EOB."),
  eob_patient_responsibility: z.number().nullable().describe("The EOB's stated 'Your Total Responsibility' or equivalent dollar amount."),
  bill_current_balance_due: z.number().nullable().describe("The bill's 'Current Balance Due' or equivalent dollar amount."),
  account_number: z.string().nullable().describe("Patient account number on the bill, if present."),
  bill_kind: BillKind.default("medical").describe("Category of the bill. Drives the negotiation playbook."),
});
export type BillMetadata = z.infer<typeof BillMetadata>;

/**
 * User-entered contact info for the billing/support department. Required
 * before the agent can launch — the hard gate is enforced in the UI and
 * re-checked server-side. Either email OR phone must be present; both is
 * better. `bill_kind` lives here too as a user-overridable mirror of the
 * value on `BillMetadata` (the analyzer's guess is a default, not a lock).
 */
export const BillContact = z.object({
  support_email: z.string().email().nullable().optional(),
  support_phone: z.string().nullable().optional()
    .describe("Billing department phone in E.164 (+15551234567) when known. Free-form OK; we normalize at dial time."),
  support_portal_url: z.string().url().nullable().optional(),
  account_holder_name: z.string().nullable().optional()
    .describe("Generalized 'patient_name' — the person whose account this is."),
  bill_kind: BillKind.optional(),
});
export type BillContact = z.infer<typeof BillContact>;

/**
 * True when the contact has at least one outbound channel — the gate the
 * UI uses to enable the Run/Resume agent button.
 */
export function hasContactChannel(c: BillContact | null | undefined): boolean {
  if (!c) return false;
  return Boolean((c.support_email && c.support_email.trim()) || (c.support_phone && c.support_phone.trim()));
}

/**
 * Final analyzer output. errors[] is in the order Claude reported them.
 * grounding_failures are findings Claude tried to record but the validator
 * rejected because line_quote didn't match the bill. We surface these in
 * dev tooling so we can diagnose model drift, but they never ship to users.
 */
export interface AnalyzerResult {
  metadata: BillMetadata;
  errors: BillingError[];
  summary: AnalysisSummary;
  grounding_failures: Array<{
    attempted_error: Partial<BillingError>;
    reason: string;
  }>;
  meta: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    elapsed_ms: number;
    tool_turns: number;
  };
}

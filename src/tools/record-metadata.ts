/**
 * `record_bill_metadata` — the tool Claude calls once, up front, to commit
 * bill-level metadata used by the appeal letter generator.
 *
 * Every field is nullable. If Claude can't find a value, it returns null and
 * the letter generator falls back to a `[bracketed placeholder]` the user can
 * fill in. This is better than inventing a provider address that will bounce.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { BillMetadata } from "../types.ts";

export const RECORD_METADATA_TOOL: Anthropic.Tool = {
  name: "record_bill_metadata",
  description:
    "Call this ONCE, BEFORE calling record_error, to commit bill- and EOB-level metadata. This is used to address the appeal letter correctly. Every field is nullable — if you cannot find a value in the documents, return null for that field. Do NOT invent values; null is strictly better than hallucination because the letter generator will surface a placeholder the user can fill in.",
  input_schema: {
    type: "object",
    required: [
      "patient_name",
      "provider_name",
      "provider_billing_address",
      "claim_number",
      "date_of_service",
      "insurer_name",
      "eob_patient_responsibility",
      "bill_current_balance_due",
      "account_number",
    ],
    properties: {
      patient_name: {
        type: ["string", "null"],
        description: "Patient's full name as it appears on the bill.",
      },
      provider_name: {
        type: ["string", "null"],
        description: "Hospital, clinic, or provider name on the bill (e.g. 'Sutter Health').",
      },
      provider_billing_address: {
        type: ["string", "null"],
        description:
          "Billing department address from the bill, as a single string. Include street, city, state, zip if present. Omit phone/fax.",
      },
      claim_number: {
        type: ["string", "null"],
        description: "Claim number from the EOB (not the bill).",
      },
      date_of_service: {
        type: ["string", "null"],
        description:
          "Date of service as it appears on the bill, e.g. '2025-03-14' or '03/14/2025'. Use the format on the document.",
      },
      insurer_name: {
        type: ["string", "null"],
        description: "Insurance company name from the EOB (e.g. 'Blue Shield of California').",
      },
      eob_patient_responsibility: {
        type: ["number", "null"],
        description:
          "The EOB's stated 'Your Total Responsibility' / 'Patient Responsibility' dollar amount. Null if not clearly stated.",
      },
      bill_current_balance_due: {
        type: ["number", "null"],
        description:
          "The bill's 'Current Balance Due' / 'Amount Due' dollar amount. Null if not clearly stated.",
      },
      account_number: {
        type: ["string", "null"],
        description: "Patient account number on the bill, if present.",
      },
    },
  },
};

export function parseMetadata(input: unknown): ReturnType<typeof BillMetadata.safeParse> {
  return BillMetadata.safeParse(input);
}

export function emptyMetadata() {
  return {
    patient_name: null,
    provider_name: null,
    provider_billing_address: null,
    claim_number: null,
    date_of_service: null,
    insurer_name: null,
    eob_patient_responsibility: null,
    bill_current_balance_due: null,
    account_number: null,
  };
}

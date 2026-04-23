/**
 * Appeal letter generator.
 *
 * Takes an AnalyzerResult (bill metadata + HIGH-confidence errors + summary)
 * and produces a formal appeal letter, deterministically. Intentionally NOT a
 * second LLM call — the analyzer already did the hard reasoning with grounded
 * quotes, and we do not want a second model turn to paraphrase (and
 * potentially drift from) those quotes.
 *
 * The letter:
 *   - Addresses the billing department by provider name + address
 *   - References the claim number, date of service, account number
 *   - Lists every HIGH-confidence error with its verbatim line_quote + evidence
 *   - States the defensible (overlap-aware) total
 *   - Invokes the No Surprises Act for balance_billing findings
 *   - Closes with a specific, reasonable ask
 *
 * Fields the analyzer returned null for render as [BRACKETED PLACEHOLDERS]
 * so the user can fill them in before sending. That's the whole point of
 * keeping null distinct from "": the letter is honest about what it doesn't
 * know.
 */
import type { AnalyzerResult, BillingError, BillMetadata } from "./types.ts";

function fmtDollar(n: number | null | undefined): string {
  if (n == null) return "[AMOUNT]";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ph(value: string | null | undefined, label: string): string {
  const s = value?.trim();
  return s && s.length > 0 ? s : `[${label}]`;
}

function todayISO(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function renderAddressBlock(meta: BillMetadata): string {
  const lines: string[] = [];
  lines.push(ph(meta.provider_name, "PROVIDER NAME"));
  lines.push("Attn: Billing Department / Patient Accounts");
  lines.push(ph(meta.provider_billing_address, "BILLING ADDRESS — STREET, CITY, STATE ZIP"));
  return lines.join("\n");
}

function renderSubjectLine(meta: BillMetadata): string {
  return `Re: Disputed charges — Patient: ${ph(meta.patient_name, "PATIENT NAME")}` +
    (meta.account_number ? ` | Account #: ${meta.account_number}` : " | Account #: [ACCOUNT NUMBER]") +
    (meta.claim_number ? ` | Claim #: ${meta.claim_number}` : " | Claim #: [CLAIM NUMBER]") +
    (meta.date_of_service ? ` | DOS: ${meta.date_of_service}` : " | DOS: [DATE OF SERVICE]");
}

function renderFindingBullet(e: BillingError, i: number): string {
  const typeLabel = e.error_type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const cpt = e.cpt_code ? ` (CPT ${e.cpt_code})` : "";
  return (
    `${i + 1}. ${typeLabel}${cpt} — ${fmtDollar(e.dollar_impact)} (Bill page ${e.page_number})\n` +
    `   Bill states: "${e.line_quote.trim()}"\n` +
    `   Why this is disputed: ${e.evidence.trim()}`
  );
}

export interface AppealLetter {
  markdown: string;
  subject: string;
  defensible_total: number;
  used_placeholders: string[]; // fields the user must fill before sending
}

export function generateAppealLetter(result: AnalyzerResult): AppealLetter {
  const meta = result.metadata;
  const high = result.errors.filter((e) => e.confidence === "high");
  const hasBalanceBilling = high.some((e) => e.error_type === "balance_billing");
  const defensibleTotal = result.summary.high_confidence_total;

  // Track placeholders so the UI / CLI can warn the user.
  const placeholders: string[] = [];
  const track = (v: unknown, label: string) => {
    if (v == null || (typeof v === "string" && v.trim() === "")) placeholders.push(label);
  };
  track(meta.patient_name, "PATIENT NAME");
  track(meta.provider_name, "PROVIDER NAME");
  track(meta.provider_billing_address, "BILLING ADDRESS");
  track(meta.claim_number, "CLAIM NUMBER");
  track(meta.date_of_service, "DATE OF SERVICE");
  track(meta.account_number, "ACCOUNT NUMBER");
  track(meta.eob_patient_responsibility, "EOB PATIENT RESPONSIBILITY");
  track(meta.bill_current_balance_due, "BILL CURRENT BALANCE DUE");

  const subject = renderSubjectLine(meta);
  const addressBlock = renderAddressBlock(meta);

  const findings = high.length
    ? high.map(renderFindingBullet).join("\n\n")
    : "No high-confidence findings. (This letter should not be sent.)";

  const eobVsBillLine = (() => {
    const pr = meta.eob_patient_responsibility;
    const cbd = meta.bill_current_balance_due;
    if (pr != null && cbd != null) {
      const diff = cbd - pr;
      return `Per the Explanation of Benefits from ${ph(meta.insurer_name, "INSURER NAME")}, my total patient responsibility is ${fmtDollar(pr)}. The bill's Current Balance Due is ${fmtDollar(cbd)} — a discrepancy of ${fmtDollar(diff)}.`;
    }
    return `Per the Explanation of Benefits from ${ph(meta.insurer_name, "INSURER NAME")}, the bill's Current Balance Due of ${fmtDollar(cbd)} exceeds my stated patient responsibility of ${fmtDollar(pr)}.`;
  })();

  const nsaParagraph = hasBalanceBilling
    ? `
Under the federal No Surprises Act (Public Law 116-260, 45 CFR Part 149), an in-network provider may not bill a patient more than the patient's cost-sharing obligation as determined by the plan. The EOB's stated patient responsibility is the ceiling of what I owe. Any amount billed beyond that — including pass-through of contractual write-offs — is improper balance billing and, where applicable, a violation of the No Surprises Act.
`.trim()
    : "";

  const ask = `
I am requesting that ${ph(meta.provider_name, "PROVIDER NAME")} correct the account as follows:

- Reduce the balance due to the EOB's stated patient responsibility of ${fmtDollar(meta.eob_patient_responsibility)}.
- Remove ${fmtDollar(defensibleTotal)} in disputed charges from my account.
- Issue a corrected itemized statement reflecting the adjustment.
- Confirm in writing within 30 days that the account has been corrected and that no adverse action (collections, credit reporting) will be taken while this dispute is pending.

Under the Fair Credit Reporting Act and the CFPB's guidance on disputed medical debts, this account must not be reported to any credit bureau while this dispute is open.
`.trim();

  const sign = `
Sincerely,

${ph(meta.patient_name, "PATIENT NAME")}
[PATIENT ADDRESS]
[PATIENT PHONE]
[PATIENT EMAIL]
`.trim();

  const md = [
    todayISO(),
    "",
    addressBlock,
    "",
    subject,
    "",
    `Dear Billing Department,`,
    "",
    `I am writing to formally dispute charges on the account referenced above. I have carefully compared the itemized bill against the Explanation of Benefits (EOB) issued by ${ph(meta.insurer_name, "INSURER NAME")}, and I have identified ${high.length} specific billing error${high.length === 1 ? "" : "s"} totaling ${fmtDollar(defensibleTotal)}.`,
    "",
    eobVsBillLine,
    "",
    `## Disputed findings`,
    "",
    findings,
    "",
    ...(nsaParagraph ? [`## Legal basis`, "", nsaParagraph, ""] : []),
    `## Requested correction`,
    "",
    ask,
    "",
    sign,
  ].join("\n");

  return {
    markdown: md,
    subject: `Disputed charges — ${ph(meta.patient_name, "PATIENT")}, Claim ${ph(meta.claim_number, "CLAIM #")}`,
    defensible_total: defensibleTotal,
    used_placeholders: placeholders,
  };
}

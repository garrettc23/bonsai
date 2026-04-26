/**
 * Appeal letter generator.
 *
 * Takes an AnalyzerResult (bill metadata + HIGH-confidence errors + summary)
 * and produces a formal appeal letter, deterministically. Intentionally NOT a
 * second LLM call — the analyzer already did the hard reasoning with grounded
 * quotes, and we do not want a second model turn to paraphrase (and
 * potentially drift from) those quotes. (Tone/style polish is handled
 * separately by src/lib/humanizer.ts at send time.)
 *
 * The letter:
 *   - Addresses the billing department by provider name + address
 *   - References the claim number, date of service, account number
 *     (only when those values are actually present — empty fields are
 *     omitted entirely, never bracketed)
 *   - Lists every HIGH-confidence error with its verbatim line_quote + evidence
 *   - States the defensible (overlap-aware) total
 *   - Invokes the No Surprises Act for balance_billing findings
 *   - Closes with a specific, reasonable ask
 *
 * Missing fields render as nothing — the line is dropped. The
 * `used_placeholders` array still tracks which fields were missing so
 * downstream consumers (UI, "needs attention" surfacing) can flag the run.
 */
import type { AnalyzerResult, BillingError, BillMetadata } from "./types.ts";

function fmtDollar(n: number | null | undefined): string | null {
  if (n == null) return null;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function present(value: string | null | undefined): string | null {
  const s = value?.trim();
  return s && s.length > 0 ? s : null;
}

function todayISO(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Address block. Drops missing lines instead of bracketing them. If even
 * the provider name is missing we still emit the "Attn:" line so the
 * recipient knows it's billing-directed.
 */
function renderAddressBlock(meta: BillMetadata): string {
  const lines: string[] = [];
  const provider = present(meta.provider_name);
  if (provider) lines.push(provider);
  lines.push("Attn: Billing Department / Patient Accounts");
  const addr = present(meta.provider_billing_address);
  if (addr) lines.push(addr);
  return lines.join("\n");
}

/**
 * Subject line. Only includes patient/account/claim/DOS pieces that are
 * actually populated. Joined by " | " so dropped fields don't leave double
 * separators.
 */
function renderSubjectLine(meta: BillMetadata): string {
  const segments: string[] = ["Disputed charges"];
  const patient = present(meta.patient_name);
  if (patient) segments[0] = `Disputed charges — Patient: ${patient}`;
  const account = present(meta.account_number);
  if (account) segments.push(`Account #: ${account}`);
  const claim = present(meta.claim_number);
  if (claim) segments.push(`Claim #: ${claim}`);
  const dos = present(meta.date_of_service);
  if (dos) segments.push(`DOS: ${dos}`);
  return `Re: ${segments.join(" | ")}`;
}

function renderFindingBullet(e: BillingError, i: number): string {
  const typeLabel = e.error_type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const cpt = e.cpt_code ? ` (CPT ${e.cpt_code})` : "";
  const dollar = fmtDollar(e.dollar_impact) ?? "amount on bill";
  return (
    `${i + 1}. ${typeLabel}${cpt} — ${dollar} (Bill page ${e.page_number})\n` +
    `   Bill states: "${e.line_quote.trim()}"\n` +
    `   Why this is disputed: ${e.evidence.trim()}`
  );
}

export interface AppealLetter {
  markdown: string;
  subject: string;
  defensible_total: number;
  /** Field names the analyzer didn't populate — surfaced so the UI can
   * flag the run as needing more info if any are critical. */
  used_placeholders: string[];
}

export function generateAppealLetter(result: AnalyzerResult): AppealLetter {
  const meta = result.metadata;
  const high = result.errors.filter((e) => e.confidence === "high");
  const hasBalanceBilling = high.some((e) => e.error_type === "balance_billing");
  const defensibleTotal = result.summary.high_confidence_total;

  // Track placeholders so the UI / CLI can warn the user. The letter no
  // longer renders these as brackets — but the orchestrator may still want
  // to know that, e.g., the claim number was missing.
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
  const insurer = present(meta.insurer_name);
  const provider = present(meta.provider_name);
  const patient = present(meta.patient_name);

  const findings = high.length
    ? high.map(renderFindingBullet).join("\n\n")
    : "No high-confidence findings. (This letter should not be sent.)";

  // EOB-vs-bill comparison line. Only renders when both numbers are
  // available; otherwise we skip the framing entirely (the findings list
  // alone carries the dispute).
  const eobVsBillLine = (() => {
    const pr = meta.eob_patient_responsibility;
    const cbd = meta.bill_current_balance_due;
    const prFmt = fmtDollar(pr);
    const cbdFmt = fmtDollar(cbd);
    if (pr != null && cbd != null && prFmt && cbdFmt) {
      const diff = cbd - pr;
      const insurerFrag = insurer ? ` from ${insurer}` : "";
      return `Per the Explanation of Benefits${insurerFrag}, my total patient responsibility is ${prFmt}. The bill's Current Balance Due is ${cbdFmt} — a discrepancy of ${fmtDollar(diff)}.`;
    }
    return null;
  })();

  const nsaParagraph = hasBalanceBilling
    ? `Under the federal No Surprises Act (Public Law 116-260, 45 CFR Part 149), an in-network provider may not bill a patient more than the patient's cost-sharing obligation as determined by the plan. The EOB's stated patient responsibility is the ceiling of what I owe. Any amount billed beyond that — including pass-through of contractual write-offs — is improper balance billing and, where applicable, a violation of the No Surprises Act.`
    : "";

  // Build the ask one bullet at a time — each line drops out cleanly when
  // its driving value isn't present, no brackets left behind.
  const askBullets: string[] = [];
  const eobFmt = fmtDollar(meta.eob_patient_responsibility);
  if (eobFmt) askBullets.push(`Reduce the balance due to the EOB's stated patient responsibility of ${eobFmt}.`);
  const defensibleFmt = fmtDollar(defensibleTotal);
  if (defensibleFmt && defensibleTotal > 0) askBullets.push(`Remove ${defensibleFmt} in disputed charges from my account.`);
  askBullets.push("Issue a corrected itemized statement reflecting the adjustment.");
  askBullets.push("Confirm in writing within 30 days that the account has been corrected and that no adverse action (collections, credit reporting) will be taken while this dispute is pending.");

  const askIntro = provider
    ? `I am requesting that ${provider} correct the account as follows:`
    : `I am requesting that the account be corrected as follows:`;
  const ask = `${askIntro}\n\n${askBullets.map((b) => `- ${b}`).join("\n")}\n\nUnder the Fair Credit Reporting Act and the CFPB's guidance on disputed medical debts, this account must not be reported to any credit bureau while this dispute is open.`;

  // Sign-off. We sign with the patient's name when we know it; otherwise
  // we close generically rather than emit a [PATIENT NAME] bracket.
  const sign = patient ? `Sincerely,\n\n${patient}` : `Sincerely,`;

  // Compose the body. Each block is conditional so missing data drops
  // entire sections cleanly instead of leaving bracketed scaffolding.
  const blocks: string[] = [];
  blocks.push(todayISO(), "");
  blocks.push(addressBlock, "");
  blocks.push(subject, "");
  blocks.push("Dear Billing Department,", "");
  const insurerFrag = insurer ? ` issued by ${insurer}` : "";
  const findingsCount = high.length;
  const totalFrag = defensibleFmt && defensibleTotal > 0 ? ` totaling ${defensibleFmt}` : "";
  blocks.push(
    `I am writing to dispute charges on the account referenced above. I have compared the itemized bill against the Explanation of Benefits${insurerFrag}, and identified ${findingsCount} specific billing error${findingsCount === 1 ? "" : "s"}${totalFrag}.`,
    "",
  );
  if (eobVsBillLine) blocks.push(eobVsBillLine, "");
  blocks.push("## Disputed findings", "", findings, "");
  if (nsaParagraph) blocks.push("## Legal basis", "", nsaParagraph, "");
  blocks.push("## Requested correction", "", ask, "");
  blocks.push(sign);

  const md = blocks.join("\n");

  // Subject for the wrapping email envelope. Mirror the in-letter subject's
  // discipline: only include identifiers that exist.
  const envelopeParts: string[] = ["Disputed charges"];
  if (patient) envelopeParts[0] = `Disputed charges — ${patient}`;
  const claim = present(meta.claim_number);
  if (claim) envelopeParts.push(`Claim ${claim}`);

  return {
    markdown: md,
    subject: envelopeParts.join(", "),
    defensible_total: defensibleTotal,
    used_placeholders: placeholders,
  };
}

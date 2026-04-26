import type { AnalyzerResult } from "../types.ts";
import type { Baseline, OfferCategory } from "../offer-agent.ts";

const PROVIDER_PATTERNS: Array<{ re: RegExp; category: OfferCategory; minBalance?: number }> = [
  { re: /walgreens|cvs(?!\s*health\s*hospital)|rite ?aid|costco pharmacy|kaiser pharmacy/i, category: "prescription" },
  { re: /quest\b|labcorp|bioreference/i, category: "lab_work" },
  { re: /radiology|imaging|\bmri\b|ct scan/i, category: "imaging" },
  { re: /dental|orthodont|dentist/i, category: "dental" },
  { re: /urgent care|minute clinic/i, category: "urgent_care" },
  { re: /hospital|medical center|\ber\b|emergency/i, category: "hospital_bill", minBalance: 1500 },
];

const DRUG_PATTERN = /\b(\d+\s*mg|tablet|capsule|atorvastatin|lisinopril|metformin|amoxicillin|levothyroxine|albuterol|omeprazole)\b/i;

export function deriveOfferBaselines(audit: AnalyzerResult): Baseline[] {
  const meta = audit.metadata;
  const provider = (meta.provider_name ?? "").trim();
  const price = typeof meta.bill_current_balance_due === "number" ? meta.bill_current_balance_due : 0;
  if (!provider || !Number.isFinite(price) || price <= 0) return [];

  const categories = new Set<OfferCategory>();

  if (meta.bill_kind === "insurance") {
    categories.add("insurance_plan");
  }

  for (const { re, category, minBalance } of PROVIDER_PATTERNS) {
    if (re.test(provider) && (minBalance == null || price >= minBalance)) {
      categories.add(category);
    }
  }

  const errorsHaveDrugMention = (audit.errors ?? []).some((e) => DRUG_PATTERN.test(e.line_quote ?? ""));
  if (errorsHaveDrugMention) categories.add("prescription");

  return Array.from(categories).map((category) => ({
    label: `${provider} ${category.replace(/_/g, " ")}`,
    category,
    current_provider: provider,
    current_price: price,
  }));
}

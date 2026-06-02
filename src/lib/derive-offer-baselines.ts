import type { AnalyzerResult } from "../types.ts";
import type { Baseline, OfferCategory } from "../offer-agent.ts";
import { categoryForBillKind, dimensionsFor } from "./comparison-dimensions.ts";

/**
 * Medical provider patterns — the analyzer runs on medical bills, so these fire
 * off the parsed provider name and (for hospital bills) a balance floor.
 */
const MEDICAL_PROVIDER_PATTERNS: Array<{ re: RegExp; category: OfferCategory; minBalance?: number }> = [
  { re: /walgreens|cvs(?!\s*health\s*hospital)|rite ?aid|costco pharmacy|kaiser pharmacy/i, category: "prescription" },
  { re: /quest\b|labcorp|bioreference/i, category: "lab_work" },
  { re: /radiology|imaging|\bmri\b|ct scan/i, category: "imaging" },
  { re: /dental|orthodont|dentist/i, category: "dental" },
  { re: /urgent care|minute clinic/i, category: "urgent_care" },
  { re: /hospital|medical center|\ber\b|emergency/i, category: "hospital_bill", minBalance: 1500 },
];

const DRUG_PATTERN = /\b(\d+\s*mg|tablet|capsule|atorvastatin|lisinopril|metformin|amoxicillin|levothyroxine|albuterol|omeprazole)\b/i;

/**
 * Non-medical provider patterns. Non-medical bills skip the analyzer, so these
 * refine the broad bill_kind default (e.g. a "telecom" bill from Comcast →
 * `internet`, from Verizon Wireless → `mobile_phone`) when the provider name is
 * recognizable. Falls back to categoryForBillKind() when nothing matches.
 */
const NON_MEDICAL_PROVIDER_PATTERNS: Array<{ re: RegExp; category: OfferCategory }> = [
  { re: /comcast|xfinity|spectrum|charter|cox|frontier|centurylink|optimum|wow!|fios internet|google fiber/i, category: "internet" },
  { re: /verizon|at&?t|t-?mobile|sprint|mint|visible|cricket|boost|metro ?pcs|us cellular/i, category: "mobile_phone" },
  { re: /geico|progressive|state farm|allstate|liberty mutual|nationwide|farmers|usaa|esurance|the general/i, category: "car_insurance" },
  { re: /lemonade|hippo|travelers|amica|erie/i, category: "home_insurance" },
  { re: /pg&?e|con ?ed|duke energy|dominion|southern california edison|sce\b|national grid|xcel|reliant|txu/i, category: "electricity" },
  { re: /socalgas|southwest gas|atmos|nicor|spire/i, category: "natural_gas" },
  { re: /netflix|hulu|disney\+?|spotify|hbo|max\b|paramount|peacock|youtube ?tv|sling/i, category: "streaming" },
  { re: /quicken loans|rocket mortgage|wells fargo|chase home|better\.com|loandepot|guaranteed rate/i, category: "mortgage_refi" },
  { re: /\bamex\b|american express|capital one|discover|citi\b|barclaycard/i, category: "credit_card" },
];

function makeBaseline(provider: string, price: number, category: OfferCategory): Baseline {
  return {
    label: `${provider} ${dimensionsFor(category).label.toLowerCase()}`,
    category,
    current_provider: provider,
    current_price: price,
    cadence: dimensionsFor(category).cadence,
  };
}

export function deriveOfferBaselines(audit: AnalyzerResult): Baseline[] {
  const meta = audit.metadata;
  const provider = (meta.provider_name ?? "").trim();
  const price = typeof meta.bill_current_balance_due === "number" ? meta.bill_current_balance_due : 0;
  if (!provider || !Number.isFinite(price) || price <= 0) return [];

  const kind = meta.bill_kind ?? "medical";
  const categories = new Set<OfferCategory>();

  if (kind === "medical") {
    // Existing medical derivation: provider-name + drug-mention patterns.
    for (const { re, category, minBalance } of MEDICAL_PROVIDER_PATTERNS) {
      if (re.test(provider) && (minBalance == null || price >= minBalance)) {
        categories.add(category);
      }
    }
    const errorsHaveDrugMention = (audit.errors ?? []).some((e) => DRUG_PATTERN.test(e.line_quote ?? ""));
    if (errorsHaveDrugMention) categories.add("prescription");
  } else {
    // Non-medical: refine the bill_kind default with a provider-name match.
    let matched = false;
    for (const { re, category } of NON_MEDICAL_PROVIDER_PATTERNS) {
      if (re.test(provider)) {
        categories.add(category);
        matched = true;
      }
    }
    if (!matched) categories.add(categoryForBillKind(kind));
  }

  return Array.from(categories).map((category) => makeBaseline(provider, price, category));
}

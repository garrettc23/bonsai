/**
 * Comparison-dimension playbooks.
 *
 * The offer-hunt agent's job is no longer "find a cheaper sticker price" — it's
 * "find an alternative that's equivalent on the dimensions that matter for this
 * category, and tell the user exactly what they keep, give up, and gain." That
 * only works if both sides agree on what those dimensions ARE. A car-insurance
 * comparison hinges on liability limits and deductibles; an internet comparison
 * hinges on speed, data cap, and promo-vs-standard pricing; a mortgage refi is a
 * break-even calculation, not a monthly-price swap.
 *
 * This module is the single source of truth for those dimensions. It is plain
 * typed data (not a prompt) because it drives two consumers: the kickoff prompt
 * the agent receives (rendered to a string) and server-side sanity checks. Per
 * the harness convention (skill-loader.ts), the caller pre-builds the block as a
 * string and passes it in, keeping formatting decisions in TypeScript where
 * they're testable.
 */
import type { OfferCategory } from "../offer-agent.ts";
import type { BillKind } from "../types.ts";

export type Cadence =
  | "monthly premium"
  | "monthly"
  | "per procedure"
  | "current balance"
  | "monthly payment";

export interface CategoryDimensions {
  /** Human-readable label for the category. */
  label: string;
  /** The cadence the baseline price is quoted on — keeps the agent comparing
   * like-for-like (a monthly premium vs a monthly premium, not vs a one-off). */
  cadence: Cadence;
  /** The axes that define equivalence. An alternative is "like-for-like" only
   * when it matches the baseline on these; the agent records keeps/gives_up/
   * gains relative to them. */
  dimensions: string[];
  /** Extra category-specific instruction appended to the kickoff (promo
   * capture, break-even math, eligibility caveats, …). */
  guidance?: string;
  /** True for financing/break-even categories (mortgage refi, balance
   * transfers) where the comparison is closing-costs-vs-monthly-savings, not a
   * simple monthly-price swap. Drives the `refi` block + the ranking gate. */
  financial?: boolean;
}

const DIMENSIONS: Record<OfferCategory, CategoryDimensions> = {
  // ---- general-purpose categories ----
  car_insurance: {
    label: "Car insurance",
    cadence: "monthly premium",
    dimensions: [
      "bodily-injury & property-damage liability limits (e.g. 100/300/100)",
      "collision & comprehensive deductibles",
      "uninsured/underinsured-motorist coverage",
      "riders the customer relies on (roadside assistance, rental reimbursement, new-car replacement)",
      "covered drivers & vehicles",
      "coverage state/region (rates and minimums are state-specific)",
    ],
    guidance:
      "Only count a quote as equivalent when liability limits and deductibles match or beat the baseline. A cheaper premium that drops to state-minimum liability is NOT like-for-like — record it but set recommended=false and list the dropped coverage under gives_up.",
  },
  home_insurance: {
    label: "Home / renters insurance",
    cadence: "monthly premium",
    dimensions: [
      "dwelling & personal-property coverage limits",
      "deductible (including separate wind/hail/hurricane deductibles)",
      "liability coverage",
      "replacement-cost vs actual-cash-value",
      "covered perils & exclusions (flood, earthquake)",
    ],
  },
  insurance_plan: {
    label: "Insurance plan",
    cadence: "monthly premium",
    dimensions: [
      "monthly premium",
      "deductible & out-of-pocket maximum",
      "coverage limits and what's covered",
      "network breadth (in-network providers the customer uses)",
      "copays / coinsurance",
    ],
  },
  internet: {
    label: "Internet",
    cadence: "monthly",
    dimensions: [
      "download / upload speed (Mbps or Gbps)",
      "data cap (and overage fees)",
      "contract length & early-termination fee",
      "equipment/modem rental fee",
      "service availability at the customer's address",
    ],
    guidance:
      "Capture promo-vs-standard pricing explicitly: most ISP prices are 12–24mo teasers. Put the teaser in promo_price_usd/promo_months and the post-promo price in standard_price_usd, and add install/equipment fees to one_time_fees_usd. A plan that's cheaper on promo but pricier at standard rate should NOT be recommended.",
  },
  mobile_phone: {
    label: "Mobile phone plan",
    cadence: "monthly",
    dimensions: [
      "data allowance (GB or unlimited) and throttling threshold",
      "number of lines",
      "hotspot allowance",
      "network coverage in the customer's region",
      "contract vs prepaid, device-financing balance",
    ],
    guidance:
      "Match line count and data tier. Flag MVNOs that deprioritize traffic on congestion under gives_up.",
  },
  electricity: {
    label: "Electricity",
    cadence: "monthly",
    dimensions: [
      "rate per kWh (and whether fixed or variable)",
      "contract length & early-termination fee",
      "renewable/green mix if the customer values it",
      "monthly base/connection charge",
    ],
    guidance:
      "Only available in deregulated markets — confirm the customer's region allows supplier choice before recommending. Variable-rate intro teasers that reset must go in promo fields.",
  },
  natural_gas: {
    label: "Natural gas",
    cadence: "monthly",
    dimensions: [
      "rate per therm (fixed or variable)",
      "contract length & cancellation fee",
      "monthly customer charge",
    ],
  },
  streaming: {
    label: "Streaming / subscription",
    cadence: "monthly",
    dimensions: [
      "content library / features the customer actually uses",
      "ad-supported vs ad-free",
      "simultaneous streams & video quality (HD/4K)",
      "annual-vs-monthly billing discount",
    ],
  },
  mortgage_refi: {
    label: "Mortgage refinance",
    cadence: "monthly payment",
    dimensions: [
      "interest rate (APR)",
      "loan term (keep it similar to avoid resetting the clock)",
      "points / origination fee",
      "total closing costs",
      "rate-and-term vs cash-out",
    ],
    financial: true,
    guidance:
      "This is a break-even calculation, NOT a monthly-price swap. Record the new rate, new term, closing costs, and resulting monthly payment in the refi block, then compute break_even_months = closing_costs / (current monthly payment - new monthly payment). Set keeps_similar_term=true only when the new term is within ~24 months of what remains on the current loan — a lower payment achieved by re-amortizing to 30 years is not a real win. Recommend only when break-even is reasonable (under ~36 months) AND the term is preserved.",
  },
  credit_card: {
    label: "Credit card / balance transfer",
    cadence: "monthly",
    dimensions: [
      "APR (purchase and balance-transfer)",
      "balance-transfer fee (%)",
      "intro 0% period length",
      "annual fee",
      "rewards structure if the customer relies on it",
    ],
    financial: true,
    guidance:
      "For balance transfers the comparison is the transfer fee vs the interest saved over the intro period. Record the transfer fee in one_time_fees_usd and treat the intro window as the horizon.",
  },
  // ---- medical categories (pre-existing) ----
  prescription: {
    label: "Prescription",
    cadence: "monthly",
    dimensions: [
      "exact drug, dose, and quantity (generic equivalence is fine; different molecule is not)",
      "cash price vs discount-program price (GoodRx, Cost Plus, Costco)",
      "pharmacy accessibility (mail-order vs local pickup)",
    ],
    guidance:
      "Match the molecule and dose. A therapeutic alternative that requires a new prescription goes under gives_up with switching_friction=high.",
  },
  lab_work: {
    label: "Lab work",
    cadence: "per procedure",
    dimensions: [
      "the same panel / test codes (CPT)",
      "cash/self-pay price",
      "in-network status with the customer's insurer",
      "location & turnaround",
    ],
  },
  imaging: {
    label: "Imaging",
    cadence: "per procedure",
    dimensions: [
      "same modality & body part (MRI w/ vs w/o contrast, etc.)",
      "cash/self-pay price",
      "facility accreditation",
      "location",
    ],
  },
  specialty_infusion: {
    label: "Specialty infusion",
    cadence: "per procedure",
    dimensions: [
      "same drug & dose",
      "site of care (hospital outpatient vs home infusion — large price driver)",
      "insurer coverage at that site",
    ],
  },
  dental: {
    label: "Dental",
    cadence: "monthly premium",
    dimensions: [
      "covered procedures & annual maximum",
      "in-network dentists nearby",
      "waiting periods",
      "monthly premium",
    ],
  },
  hospital_bill: {
    label: "Hospital bill",
    cadence: "current balance",
    dimensions: [
      "the same procedure (CPT/DRG) at a different facility",
      "cash/self-pay or financial-assistance price",
      "facility quality / accreditation",
    ],
    guidance:
      "An existing balance can't be 'switched', but a future equivalent procedure can be priced elsewhere. Frame offers as 'next time, this costs X here'.",
  },
  urgent_care: {
    label: "Urgent care",
    cadence: "per procedure",
    dimensions: [
      "same visit type",
      "cash price",
      "location & hours",
    ],
  },
  house_insurance: {
    label: "Homeowners insurance",
    cadence: "monthly premium",
    dimensions: [
      "dwelling & personal-property limits",
      "deductible (incl. wind/hail)",
      "liability coverage",
      "replacement-cost vs actual-cash-value",
    ],
  },
  other: {
    label: "Other",
    cadence: "monthly",
    dimensions: [
      "the core service/features the customer is paying for",
      "contract terms & fees",
      "total cost over a 12-month horizon",
    ],
  },
};

/** Default category for a BillKind when a more specific one can't be derived. */
const BILL_KIND_DEFAULT: Record<BillKind, OfferCategory> = {
  medical: "hospital_bill",
  telecom: "internet",
  utility: "electricity",
  subscription: "streaming",
  insurance: "insurance_plan",
  financial: "mortgage_refi",
  other: "other",
};

export function dimensionsFor(category: OfferCategory): CategoryDimensions {
  return DIMENSIONS[category] ?? DIMENSIONS.other;
}

export function categoryForBillKind(kind: BillKind): OfferCategory {
  return BILL_KIND_DEFAULT[kind] ?? "other";
}

/** Map a comparison category back to a BillKind (for run metadata / display). */
export function billKindForCategory(category: OfferCategory): BillKind {
  switch (category) {
    case "internet":
    case "mobile_phone":
      return "telecom";
    case "electricity":
    case "natural_gas":
      return "utility";
    case "streaming":
      return "subscription";
    case "car_insurance":
    case "home_insurance":
    case "house_insurance":
    case "insurance_plan":
    case "dental":
      return "insurance";
    case "mortgage_refi":
    case "credit_card":
      return "financial";
    case "prescription":
    case "lab_work":
    case "imaging":
    case "specialty_infusion":
    case "hospital_bill":
    case "urgent_care":
      return "medical";
    default:
      return "other";
  }
}

export function isFinancialCategory(category: OfferCategory): boolean {
  return dimensionsFor(category).financial === true;
}

/**
 * Render a category's equivalence dimensions as a prompt block injected into
 * the per-baseline kickoff. Kept here (not in the markdown skill) because it's
 * derived from the same typed data the server validates against.
 */
export function renderDimensionBlock(category: OfferCategory): string {
  const d = dimensionsFor(category);
  const lines = [
    `## Equivalence dimensions for ${d.label}`,
    `Compare the baseline and every alternative on these axes — an alternative is "like-for-like" only when it matches or beats the baseline on them:`,
    ...d.dimensions.map((dim) => `- ${dim}`),
  ];
  if (d.guidance) {
    lines.push("", d.guidance);
  }
  return lines.join("\n");
}

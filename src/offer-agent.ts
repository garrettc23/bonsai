/**
 * Offer Agent — finds cheaper alternatives for a recurring medical bill or
 * one-off procedure.
 *
 * Unlike the negotiation agent (which disputes a specific bill with its
 * provider), the offer agent reaches out to alternative sources to get
 * comparison quotes. Sources vary by category: prescriptions go to GoodRx,
 * Mark Cuban Cost Plus, Costco; labs go to direct-pay labs; specialty
 * infusions go to infusion centers vs hospital outpatient; insurance swaps go
 * to Covered California; hospital bills go to charity care programs.
 *
 * Each source has a channel preference (email or voice) with its own
 * simulator persona that replies with a quote. The agent parses the quote,
 * compares to baseline, and stops as soon as it finds one lower — OR after
 * exhausting all sources for the category, confirms the current provider is
 * already the lowest.
 *
 * This is Workflow 2 from the user brief: "shouldn't finish until it's found a
 * lower price or has exhausted all options and confirmed the user has the
 * lowest price."
 */
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentUserPaths } from "./lib/user-paths.ts";

const MODEL = "claude-opus-4-7";

function offersOutDir(): string {
  return currentUserPaths().offersDir;
}

export type OfferChannel = "email" | "voice";
export type OfferCategory =
  | "prescription"
  | "insurance_plan"
  | "lab_work"
  | "imaging"
  | "specialty_infusion"
  | "dental"
  | "hospital_bill"
  | "urgent_care"
  | "house_insurance";

export interface Baseline {
  label: string;
  category: OfferCategory;
  current_provider: string;
  /** Current monthly or per-procedure price in USD. */
  current_price: number;
  /** Optional extra context the agent can pass to sources (e.g. medication name, lab panel). */
  specifics?: string;
  /** Zip or city so simulator personas can quote realistic regional prices. */
  region?: string;
}

export interface OfferSource {
  id: string;
  name: string;
  channel: OfferChannel;
  /** One-line persona used to simulate this source's reply. */
  persona: string;
  /**
   * Price distribution hint baked into the persona so quotes are realistic
   * without Claude hallucinating wildly. These are ranges the source is
   * KNOWN to come in at relative to typical retail. The simulator is told
   * to respect this ratio.
   */
  quote_multiplier_range: [number, number];
  /** Some sources refuse to quote over text — simulates real-world frustration. */
  refuse_probability?: number;
}

const SOURCE_DIRECTORY: Record<OfferCategory, OfferSource[]> = {
  prescription: [
    {
      id: "goodrx",
      name: "GoodRx",
      channel: "email",
      persona:
        "You are a GoodRx support email bot. Patients email you with a medication name + quantity + pharmacy zip. Reply with the GoodRx cash price at the nearest chain, plus the 2 lowest nearby pharmacies. Always quote a real-seeming number. No upsell, no fluff.",
      quote_multiplier_range: [0.15, 0.55],
    },
    {
      id: "costplus",
      name: "Mark Cuban Cost Plus Drug Company",
      channel: "email",
      persona:
        "You are a Cost Plus Drugs support email rep. Quote their transparent price: manufacturer cost + 15% markup + $5 pharmacy fee + $5 shipping. For common generics this almost always beats insurance copay. Reply with the exact breakdown.",
      quote_multiplier_range: [0.05, 0.35],
    },
    {
      id: "costco",
      name: "Costco Member Pharmacy",
      channel: "voice",
      persona:
        "You are a Costco Member Pharmacy tech on a phone call. You're friendly, fast, give the Costco member price directly. Non-members pay ~20% more but you quote both. No sales pitch.",
      quote_multiplier_range: [0.2, 0.6],
    },
    {
      id: "indie_pharm",
      name: "Local independent pharmacy",
      channel: "email",
      persona:
        "You are a local independent pharmacist replying by email. You're helpful but curt. Quote retail minus a small cash-pay discount (~10%). Suggest the patient check Cost Plus for generics.",
      quote_multiplier_range: [0.7, 1.1],
      refuse_probability: 0.2,
    },
  ],
  insurance_plan: [
    {
      id: "covered_ca",
      name: "Covered California — plan advisor",
      channel: "email",
      persona:
        "You are a Covered California licensed plan advisor emailing a member. Given current premium + zip + household income (assume ~$90k SF), quote 2 comparable Silver plans with lower premiums. Show the subsidy math. Professional, concrete.",
      quote_multiplier_range: [0.55, 0.92],
    },
    {
      id: "healthsherpa",
      name: "HealthSherpa",
      channel: "email",
      persona:
        "You are a HealthSherpa email assistant. Quote 1 plan with better rate than current if the patient qualifies for subsidies. Terse — 2-4 lines. Always include plan name and monthly premium.",
      quote_multiplier_range: [0.6, 0.95],
    },
  ],
  lab_work: [
    {
      id: "labcorp_direct",
      name: "Labcorp OnDemand (direct-pay)",
      channel: "email",
      persona:
        "You are a Labcorp OnDemand email rep. Quote direct-pay prices that bypass insurance entirely. For common panels (CMP, CBC, A1C, thyroid) direct-pay is 40–70% below insurance-billed rate. Professional, quick.",
      quote_multiplier_range: [0.25, 0.5],
    },
    {
      id: "quest_qm",
      name: "Quest QuestDirect",
      channel: "email",
      persona:
        "You are a Quest QuestDirect email rep. Quote the direct-pay list price. Usually matches Labcorp OnDemand within ~$5.",
      quote_multiplier_range: [0.25, 0.5],
    },
    {
      id: "walmart_care",
      name: "Walmart Health Virtual Care",
      channel: "voice",
      persona:
        "You are a Walmart Health Virtual Care phone associate. Quote flat cash price for the lab panel — typically the lowest in the market. Friendly. Include taxes.",
      quote_multiplier_range: [0.2, 0.45],
    },
  ],
  imaging: [
    {
      id: "radnet",
      name: "RadNet outpatient imaging",
      channel: "voice",
      persona:
        "You are a RadNet scheduling phone associate. Quote the self-pay rate for the study — usually 40–60% of hospital outpatient. Confirm accreditation + turnaround.",
      quote_multiplier_range: [0.35, 0.65],
    },
    {
      id: "outpatient_imaging_ctr",
      name: "Independent outpatient imaging center",
      channel: "email",
      persona:
        "You are an email rep for an independent imaging center. Quote 30–50% of hospital outpatient for MRI/CT/US. Accept most insurance; also quote self-pay.",
      quote_multiplier_range: [0.3, 0.55],
    },
  ],
  specialty_infusion: [
    {
      id: "community_infusion",
      name: "Community infusion center",
      channel: "voice",
      persona:
        "You are a community infusion center nurse manager on a phone call. For the same biologic, facility fees run 40–70% below hospital outpatient. Quote inclusive of drug + admin + observation.",
      quote_multiplier_range: [0.35, 0.7],
    },
    {
      id: "home_infusion",
      name: "Home infusion agency",
      channel: "email",
      persona:
        "You are a home-infusion agency email rep. For biologics suitable for home admin, quote 50–80% of hospital cost. Include nurse visit + supplies + pump rental.",
      quote_multiplier_range: [0.4, 0.8],
    },
  ],
  dental: [
    {
      id: "delta_dental_marketplace",
      name: "Delta Dental individual plans",
      channel: "email",
      persona:
        "You are a Delta Dental individual-plan email rep. Quote 1–2 individual plans matching current coverage at lower monthly premium.",
      quote_multiplier_range: [0.65, 1.0],
    },
    {
      id: "dentalsave",
      name: "DentalSave discount plan",
      channel: "email",
      persona:
        "You are a DentalSave email rep. Quote a discount-plan alternative — not insurance, membership-based. Usually beats individual dental insurance for low-utilizers. Terse — 2-4 lines.",
      quote_multiplier_range: [0.35, 0.7],
    },
  ],
  hospital_bill: [
    {
      id: "charity_care",
      name: "Hospital charity care office",
      channel: "voice",
      persona:
        "You are a hospital financial-counseling office phone rep. For household income under 400% FPL you qualify for 70–100% adjustment. Quote a sliding-scale reduction based on typical hospital charity care policies. Helpful, patient.",
      quote_multiplier_range: [0.0, 0.4],
    },
    {
      id: "pt_advocacy",
      name: "Patient advocacy nonprofit",
      channel: "email",
      persona:
        "You are a patient advocacy nonprofit email rep. Offer to file a hardship appeal on the patient's behalf; estimate a 40–60% reduction based on case typicals. Also mention free 340B drug discounts if applicable.",
      quote_multiplier_range: [0.4, 0.7],
    },
  ],
  urgent_care: [
    {
      id: "direct_care_clinic",
      name: "Direct-pay urgent care",
      channel: "voice",
      persona:
        "You are a direct-pay urgent care front-desk phone rep. Flat $95–$145 visit fee. No facility fees. Compare to ER ($1500+) which is what they just paid.",
      quote_multiplier_range: [0.05, 0.15],
    },
    {
      id: "telehealth",
      name: "Telehealth visit (Teladoc)",
      channel: "email",
      persona:
        "You are a Teladoc support email rep. Flat $0–$75 for a video visit, covered by most employer plans. 4–6 lines, no fluff.",
      quote_multiplier_range: [0.0, 0.08],
    },
  ],
  house_insurance: [
    {
      id: "lemonade",
      name: "Lemonade Homeowners",
      channel: "email",
      persona:
        "You are a Lemonade homeowners-insurance email rep. Quote a policy with equivalent dwelling/personal-property/liability coverage at typically 25–45% below legacy carriers. Show the monthly premium, deductible, and a one-line note on coverage match. Brief, professional.",
      quote_multiplier_range: [0.55, 0.8],
    },
    {
      id: "hippo",
      name: "Hippo Home Insurance",
      channel: "email",
      persona:
        "You are a Hippo home-insurance email rep. Quote with equivalent coverage plus their smart-home discount applied (up to 13%). Reply with monthly premium, deductible, and a one-line summary of what's included.",
      quote_multiplier_range: [0.6, 0.9],
    },
    {
      id: "indep_broker_home",
      name: "Independent insurance broker (home)",
      channel: "voice",
      persona:
        "You are an independent home-insurance broker on a phone call. You compare 6–8 carriers and quote the best premium for the same dwelling/liability limits. Friendly, concrete. Mention the carrier name and bind timeline.",
      quote_multiplier_range: [0.65, 0.95],
    },
  ],
};

export interface OfferQuote {
  source_id: string;
  source_name: string;
  channel: OfferChannel;
  quoted_price: number | null;
  currency: "USD";
  notes: string;
  /** Raw text of the source's reply (email body / call summary). */
  raw_reply: string;
  /** How much the patient would save monthly (or per-procedure) vs baseline. null if source declined. */
  savings_vs_baseline: number | null;
  /** Round-trip latency in ms for the simulated exchange. Useful telemetry. */
  elapsed_ms: number;
}

export interface OfferHuntResult {
  baseline: Baseline;
  quotes: OfferQuote[];
  best: OfferQuote | null;
  outcome:
    | "lower_price_found" // found a quote below baseline — stopped early
    | "current_is_lowest" // all sources checked, none beat baseline
    | "all_declined"; // no source produced a quote at all
  headline: string;
  total_monthly_savings: number | null;
  started_at: string;
  completed_at: string;
}

interface RunOfferHuntOpts {
  baseline: Baseline;
  /**
   * Stop at the first quote lower than baseline (default true). If false, the
   * agent queries ALL sources for the category and returns the full ranking.
   */
  stop_on_first_win?: boolean;
  anthropic?: Anthropic;
}

function fmt$(n: number | null | undefined): string {
  if (n == null) return "$—";
  return `$${n.toFixed(2)}`;
}

/**
 * Ask Claude to role-play the source and return a plausible quote in structured
 * JSON. Every source is one API call. We constrain output with a tool call so
 * parsing is deterministic.
 */
async function queryOneSource(opts: {
  baseline: Baseline;
  source: OfferSource;
  anthropic: Anthropic;
}): Promise<OfferQuote> {
  const { baseline, source, anthropic } = opts;
  const start = Date.now();

  const [minMul, maxMul] = source.quote_multiplier_range;
  const hint = `For reference: a typical ${baseline.category} alternative from "${source.name}" comes in around ${(minMul * 100).toFixed(0)}–${(maxMul * 100).toFixed(
    0,
  )}% of the patient's current ${fmt$(baseline.current_price)} price. Pick a realistic number INSIDE that range. Vary within the range — do not always pick the midpoint.`;

  const system = `${source.persona}

You reply via ${source.channel.toUpperCase()}. Keep the reply ${source.channel === "email" ? "brief and professional, 4–8 lines of plain email prose with a signoff" : "as a 3–6 line transcribed phone call summary: rep greeting, quote, confirm details"}. No markdown.

${hint}

If the refuse probability applies and you decline, say so directly without a number.`;

  const user = `## Patient context
Baseline: ${baseline.label}
Category: ${baseline.category}
Current provider: ${baseline.current_provider}
Current price: ${fmt$(baseline.current_price)} ${baseline.category === "insurance_plan" ? "(monthly premium)" : baseline.category === "dental" ? "(monthly premium)" : "(per procedure / per month)"}
${baseline.specifics ? `Specifics: ${baseline.specifics}` : ""}
${baseline.region ? `Region: ${baseline.region}` : ""}

## Your task

Reply to the patient as ${source.name} over ${source.channel}. Give a concrete quote OR decline. Then call the \`report_quote\` tool with the structured fields.`;

  const tool: Anthropic.Tool = {
    name: "report_quote",
    description: "Report the quote you gave the patient in structured form.",
    input_schema: {
      type: "object",
      required: ["reply_text", "declined"],
      properties: {
        reply_text: {
          type: "string",
          description: "The full reply text you would send the patient over the channel.",
        },
        declined: {
          type: "boolean",
          description: "True if you refused to give a quote over this channel.",
        },
        quoted_price: {
          type: "number",
          minimum: 0,
          description: "Your quoted price in USD. Omit if declined=true.",
        },
        notes: {
          type: "string",
          description: "1-sentence reason this quote is better/worse than baseline, or why you declined.",
        },
      },
    },
  };

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 768,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: "report_quote" },
    messages: [{ role: "user", content: user }],
  });

  const call = resp.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "report_quote",
  );
  const elapsed_ms = Date.now() - start;
  if (!call) {
    return {
      source_id: source.id,
      source_name: source.name,
      channel: source.channel,
      quoted_price: null,
      currency: "USD",
      notes: "Source did not produce a structured quote.",
      raw_reply: "(empty)",
      savings_vs_baseline: null,
      elapsed_ms,
    };
  }
  const input = call.input as {
    reply_text: string;
    declined: boolean;
    quoted_price?: number;
    notes?: string;
  };
  const price = input.declined ? null : input.quoted_price ?? null;
  const savings = price != null ? baseline.current_price - price : null;
  return {
    source_id: source.id,
    source_name: source.name,
    channel: source.channel,
    quoted_price: price,
    currency: "USD",
    notes: input.notes ?? (input.declined ? "Declined to quote." : ""),
    raw_reply: input.reply_text,
    savings_vs_baseline: savings,
    elapsed_ms,
  };
}

/**
 * Run the offer hunt. Loops over every source for the baseline's category,
 * sequentially (so you see the outreach order in the transcript). Stops at
 * the first source that beats baseline, unless stop_on_first_win=false.
 */
export async function runOfferHunt(opts: RunOfferHuntOpts): Promise<OfferHuntResult> {
  const anthropic = opts.anthropic ?? new Anthropic();
  const stopEarly = opts.stop_on_first_win ?? true;
  const started_at = new Date().toISOString();
  const sources = SOURCE_DIRECTORY[opts.baseline.category];
  if (!sources || sources.length === 0) {
    return {
      baseline: opts.baseline,
      quotes: [],
      best: null,
      outcome: "all_declined",
      headline: `No source directory for category "${opts.baseline.category}".`,
      total_monthly_savings: null,
      started_at,
      completed_at: new Date().toISOString(),
    };
  }

  const quotes: OfferQuote[] = [];
  let winner: OfferQuote | null = null;
  for (const source of sources) {
    const q = await queryOneSource({ baseline: opts.baseline, source, anthropic });
    quotes.push(q);
    if (q.quoted_price != null && q.quoted_price < opts.baseline.current_price) {
      if (!winner || q.quoted_price < (winner.quoted_price as number)) winner = q;
      if (stopEarly) break;
    }
  }

  const priced = quotes.filter((q) => q.quoted_price != null);
  let best: OfferQuote | null = null;
  if (priced.length > 0) {
    best = priced[0];
    for (const q of priced) if ((q.quoted_price as number) < (best.quoted_price as number)) best = q;
  }

  let outcome: OfferHuntResult["outcome"];
  let headline: string;
  let savings: number | null = null;
  if (winner) {
    outcome = "lower_price_found";
    savings = opts.baseline.current_price - (winner.quoted_price as number);
    headline = `Found ${winner.source_name} at ${fmt$(winner.quoted_price)} vs your ${fmt$(opts.baseline.current_price)} — saves ${fmt$(savings)}/mo.`;
  } else if (priced.length > 0) {
    outcome = "current_is_lowest";
    headline = `Checked ${quotes.length} alternatives. None beat your current ${fmt$(opts.baseline.current_price)}. You have the lowest price in this category.`;
  } else {
    outcome = "all_declined";
    headline = `Contacted ${quotes.length} sources. None produced a usable quote. Consider escalating to a human advocate.`;
  }

  const completed_at = new Date().toISOString();
  return {
    baseline: opts.baseline,
    quotes,
    best,
    outcome,
    headline,
    total_monthly_savings: savings,
    started_at,
    completed_at,
  };
}

/** Persist a run to out/users/<id>/offers/{ts}-{baseline_slug}.json so the UI can list history. */
export function saveOfferHunt(result: OfferHuntResult): string {
  const dir = offersOutDir();
  mkdirSync(dir, { recursive: true });
  const slug = result.baseline.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  const fname = `${Date.now()}-${slug || "offer"}.json`;
  const full = join(dir, fname);
  writeFileSync(full, JSON.stringify(result, null, 2), "utf8");
  return fname;
}

export function offersDir(): string {
  const dir = offersOutDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Source directory is exported so the UI can show which sources will be checked. */
export const OFFER_SOURCE_DIRECTORY = SOURCE_DIRECTORY;

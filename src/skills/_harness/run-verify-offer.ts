/**
 * Typed wrapper around the verify-offer skill.
 *
 * The comparison-hunt agent (Claude, via Managed Agents) records offers; this
 * pass runs an independent cross-model verifier (GPT-5) over each recommended
 * offer to score confidence and flag promo-only / eligibility-gated deals before
 * they reach the user. Mirrors run-fact-check.ts:
 *
 *   1. Disabled by default — only runs when BONSAI_CROSSMODAL=1 is set. Same
 *      gradual-rollout gate the negotiation cross-modal passes use.
 *   2. Fail-open — any error (no key, rate limit, malformed output) leaves the
 *      offer's existing confidence untouched and marks the check skipped. We
 *      never drop an offer on an eval failure.
 */
import { runSkill } from "./skill-runner.ts";
import type { LLMTool, ProviderRunners } from "../../llm/provider.ts";
import type { Baseline, OfferRecord } from "../../offer-agent.ts";

export interface VerifyOfferResult {
  confidence: number;
  verified: boolean;
  flags: string[];
  /** True when the check was skipped (env gate off or fail-open path). */
  skipped: boolean;
}

const VERIFY_OFFER_TOOL: LLMTool = {
  name: "verify_offer_report",
  description: "Report how credible the recorded comparison offer is.",
  input_schema: {
    type: "object",
    required: ["confidence", "verified", "flags"],
    properties: {
      confidence: { type: "number", description: "0–1 trust in the offer as recorded." },
      verified: { type: "boolean" },
      flags: { type: "array", items: { type: "string" } },
    },
  },
};

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function fmt$(n: number | null | undefined): string {
  return n == null ? "$—" : `$${n.toFixed(2)}`;
}

function baselineSummary(b: Baseline): string {
  return [
    `Category: ${b.category}`,
    `Current provider: ${b.current_provider}`,
    `Current price: ${fmt$(b.current_price)} (${b.cadence ?? "monthly"})`,
    b.specifics ? `Specifics: ${b.specifics}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function offerSummary(o: OfferRecord): string {
  const nc = o.normalized_cost;
  const eq = o.equivalence;
  const lines = [
    `Provider: ${o.provider}`,
    `Sticker price: ${fmt$(o.price_usd)}`,
    `Recommended: ${o.recommended}`,
    `Terms URL: ${o.terms_url}`,
    `Switching friction: ${o.switching_friction ?? "unknown"}`,
  ];
  if (nc) {
    lines.push(
      `Effective monthly: ${fmt$(nc.effective_monthly_usd)} over ${nc.horizon_months}mo` +
        (nc.promo_price_usd != null
          ? ` (promo ${fmt$(nc.promo_price_usd)} for ${nc.promo_months ?? "?"}mo, then ${fmt$(nc.standard_price_usd)})`
          : "") +
        (nc.one_time_fees_usd ? `, one-time fees ${fmt$(nc.one_time_fees_usd)}` : ""),
    );
  }
  if (eq) {
    lines.push(
      `Keeps: ${eq.keeps.join("; ") || "—"}`,
      `Gives up: ${eq.gives_up.join("; ") || "—"}`,
      `Gains: ${eq.gains.join("; ") || "—"}`,
      `Parity score: ${eq.parity_score}`,
    );
  }
  if (o.refi) {
    lines.push(
      `Refi: rate ${o.refi.new_rate_pct}%, term ${o.refi.new_term_months}mo, ` +
        `closing ${fmt$(o.refi.closing_costs_usd)}, payment ${fmt$(o.refi.monthly_payment_usd)}, ` +
        `break-even ${o.refi.break_even_months}mo, keeps_similar_term ${o.refi.keeps_similar_term}`,
    );
  }
  if (o.notes) lines.push(`Notes: ${o.notes}`);
  return lines.join("\n");
}

export interface VerifyOfferOpts {
  offer: OfferRecord;
  baseline: Baseline;
  runners?: ProviderRunners;
}

export async function verifyOffer(opts: VerifyOfferOpts): Promise<VerifyOfferResult> {
  const existing = opts.offer.confidence ?? 0.5;
  if (process.env.BONSAI_CROSSMODAL !== "1") {
    return { confidence: existing, verified: opts.offer.verified ?? false, flags: [], skipped: true };
  }
  try {
    const resp = await runSkill("verify-offer", {
      vars: {
        baseline_summary: baselineSummary(opts.baseline),
        offer_summary: offerSummary(opts.offer),
      },
      user: "Verify this offer now and return your decision via the verify_offer_report tool.",
      tools: [VERIFY_OFFER_TOOL],
      runners: opts.runners,
    });
    if (!resp.tool_use || resp.tool_use.name !== "verify_offer_report") {
      console.warn("[verify-offer] no tool call in response — leaving confidence as-is");
      return { confidence: existing, verified: opts.offer.verified ?? false, flags: [], skipped: true };
    }
    const input = resp.tool_use.input as { confidence?: unknown; verified?: unknown; flags?: unknown };
    const flags = Array.isArray(input.flags)
      ? input.flags.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [];
    return {
      confidence: clamp01(input.confidence),
      verified: input.verified === true,
      flags,
      skipped: false,
    };
  } catch (err) {
    console.warn(`[verify-offer] failed, leaving confidence as-is: ${(err as Error).message}`);
    return { confidence: existing, verified: opts.offer.verified ?? false, flags: [], skipped: true };
  }
}

/**
 * Verify every recommended offer in place. Mutates `confidence`, `verified`, and
 * (when flags surface) appends them to the offer's notes so the UI can show them.
 * Sequential to keep concurrent OpenAI calls bounded — hunts rarely produce more
 * than a handful of recommended offers. No-op (per-offer skipped) when the
 * cross-modal gate is off. The caller recomputes net_value_score afterward, since
 * confidence feeds the ranking.
 */
export async function verifyOffers(offers: OfferRecord[], baseline: Baseline): Promise<void> {
  for (const offer of offers) {
    if (!offer.recommended) continue;
    const result = await verifyOffer({ offer, baseline });
    if (result.skipped) continue;
    offer.confidence = result.confidence;
    offer.verified = result.verified;
    if (result.flags.length > 0) {
      const flagNote = `Verification flags: ${result.flags.join(", ")}.`;
      offer.notes = offer.notes ? `${offer.notes} ${flagNote}` : flagNote;
    }
  }
}

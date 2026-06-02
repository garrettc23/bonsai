/**
 * Offer Agent — finds cheaper alternatives for a recurring medical bill or
 * one-off procedure.
 *
 * Backed by Anthropic's Managed Agents SDK. Each hunt opens a session against
 * a long-lived agent (created once, cached in SQLite) and listens for
 * `record_offer` / `mark_exhausted` custom-tool calls until the session goes
 * idle with a terminal stop_reason.
 *
 * Public surface — `runOfferHunt(opts)`, `saveOfferHunt(result)`,
 * `offersDir()`, `Baseline`, `OfferRecord`, `OfferHuntResult` — is preserved
 * so `handleOfferHunt` in src/server.ts continues to work unchanged.
 */
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getOrCreateOfferAgent } from "./lib/managed-agent-cache.ts";
import { currentUserPaths } from "./lib/user-paths.ts";
import {
  dimensionsFor,
  isFinancialCategory,
  renderDimensionBlock,
} from "./lib/comparison-dimensions.ts";
import { verifyOffers } from "./skills/_harness/run-verify-offer.ts";

/**
 * Maximum break-even horizon (months) for a mortgage refi to be recommended.
 * A refi whose closing costs take longer than this to recoup isn't a win even
 * if it lowers the monthly payment.
 */
const REFI_BREAK_EVEN_CAP_MONTHS = 36;

function offersOutDir(): string {
  return currentUserPaths().offersDir;
}

export type OfferChannel = "email" | "voice";
export type OfferCategory =
  // medical (original set)
  | "prescription"
  | "insurance_plan"
  | "lab_work"
  | "imaging"
  | "specialty_infusion"
  | "dental"
  | "hospital_bill"
  | "urgent_care"
  | "house_insurance"
  // general-purpose set (added in the comparison-engine rebuild)
  | "car_insurance"
  | "home_insurance"
  | "internet"
  | "mobile_phone"
  | "electricity"
  | "natural_gas"
  | "streaming"
  | "mortgage_refi"
  | "credit_card"
  | "other";

export type SwitchingFriction = "low" | "medium" | "high";

/**
 * What switching actually means — the core of the comparison engine. The agent
 * profiles the baseline and the alternative on the category's equivalence
 * dimensions (see lib/comparison-dimensions.ts) and reports the delta so the UI
 * can show "you keep X, give up Y, gain Z" instead of just a cheaper number.
 */
export interface OfferEquivalence {
  /** Dimensions the alternative matches (e.g. "100/300 liability", "1Gbps"). */
  keeps: string[];
  /** Where the alternative is worse (e.g. "no roadside assistance"). */
  gives_up: string[];
  /** Where the alternative is better (e.g. "no annual contract"). */
  gains: string[];
  /** 0–1: how like-for-like the alternative is vs the baseline. */
  parity_score: number;
}

/**
 * True cost over a horizon, not a sticker price. Captures the promo→standard
 * step-up and one-time fees that make a cheap teaser a false win.
 */
export interface OfferNormalizedCost {
  /** What the plan really averages to per month over `horizon_months`. */
  effective_monthly_usd: number;
  /** Window the average covers (e.g. 24mo so a 12mo promo is half-weighted). */
  horizon_months: number;
  promo_price_usd?: number;
  promo_months?: number;
  /** Price after the promo ends. */
  standard_price_usd?: number;
  /** Install / equipment / activation / transfer fees. */
  one_time_fees_usd?: number;
}

/** Financing/break-even block — populated only for financial categories. */
export interface OfferRefi {
  new_rate_pct: number;
  new_term_months: number;
  closing_costs_usd: number;
  monthly_payment_usd: number;
  /** closing_costs / (current monthly payment - new monthly payment). */
  break_even_months: number;
  /** True when the new term is close to what remains on the current loan. */
  keeps_similar_term: boolean;
}

export interface Baseline {
  label: string;
  category: OfferCategory;
  current_provider: string;
  /** Current monthly or per-procedure price in USD. Treated as the baseline's
   * effective monthly cost for normalized comparison. */
  current_price: number;
  /** How current_price is quoted ("monthly premium", "monthly payment", …).
   * Defaults from the category playbook when absent. */
  cadence?: string;
  /** Optional extra context passed to the agent (medication name, plan tier,
   * coverage limits, current rate/term for refi). */
  specifics?: string;
  /** Zip or city so the agent can search regionally. */
  region?: string;
}

export interface OfferRecord {
  provider: string;
  price_usd: number;
  terms_url: string;
  channel?: OfferChannel;
  notes?: string;
  recommended: boolean;
  /** Normalized savings: baseline.current_price - normalized effective monthly.
   * Negative means worse than baseline. Falls back to sticker delta when the
   * agent didn't supply a normalized cost. */
  savings_vs_baseline: number;
  // ---- comparison-engine fields (optional for back-compat with legacy files) ----
  equivalence?: OfferEquivalence;
  normalized_cost?: OfferNormalizedCost;
  refi?: OfferRefi | null;
  /** 0–1 confidence the recorded price/terms are real and current. Set/raised
   * by the verify-offer pass; defaults to a neutral prior when unverified. */
  confidence?: number;
  verified?: boolean;
  /** ISO date the price was confirmed against the terms page. */
  price_as_of?: string;
  switching_friction?: SwitchingFriction;
  /** Composite rank — see netValueScore(). Higher is better. */
  net_value_score?: number;
}

/** Alias documenting the upgraded shape; structurally identical to OfferRecord. */
export type ComparisonOffer = OfferRecord;

export interface OfferHuntResult {
  baseline: Baseline;
  offers: OfferRecord[];
  best: OfferRecord | null;
  outcome:
    | "lower_price_found" // at least one recommended offer beats baseline
    | "current_is_lowest" // exhausted with offers recorded but none recommended
    | "exhausted_no_results"; // exhausted without any usable offer
  headline: string;
  total_monthly_savings: number | null;
  started_at: string;
  completed_at: string;
  /**
   * The PendingRun that produced this hunt. When the bill behind that run
   * is deleted, the offer file is cleaned up (and projectOfferHistory
   * filters out any orphans missed by the cleanup). Optional so legacy
   * offer files written before this field landed still parse — the
   * projection treats unknown run_ids as orphans.
   */
  run_id?: string;
}

interface RunOfferHuntOpts {
  baseline: Baseline;
  /** PendingRun this hunt is bound to. Stamped on the saved file so the
   * Comparison view can be filtered by active runs and a bill delete can
   * sweep its associated offer files. */
  run_id?: string;
  /** @deprecated retained for caller compatibility — the agent handles its own stopping logic. */
  stop_on_first_win?: boolean;
  anthropic?: Anthropic;
}

function fmt$(n: number | null | undefined): string {
  if (n == null) return "$—";
  return `$${n.toFixed(2)}`;
}

function buildKickoffPrompt(baseline: Baseline): string {
  const cadence = baseline.cadence ?? dimensionsFor(baseline.category).cadence;
  const financial = isFinancialCategory(baseline.category);
  return [
    `Find equivalent alternatives to the following baseline and report what the customer would keep, give up, and gain by switching.`,
    ``,
    `Baseline: ${baseline.label}`,
    `Category: ${baseline.category}`,
    `Current provider: ${baseline.current_provider}`,
    `Current price: ${fmt$(baseline.current_price)} (${cadence})`,
    baseline.specifics ? `Specifics: ${baseline.specifics}` : "",
    baseline.region ? `Region: ${baseline.region}` : "",
    ``,
    renderDimensionBlock(baseline.category),
    ``,
    `## How to record`,
    `Use web_search and web_fetch to find real, switchable alternatives. For each one:`,
    `1. Fetch the terms/pricing page and confirm the price before recording — never record a price you haven't seen on a real page.`,
    `2. Fill the equivalence block (keeps / gives_up / gains relative to the dimensions above, plus a 0–1 parity_score).`,
    `3. Fill normalized_cost with the true effective monthly cost over a 12–24 month horizon — capture any promo-vs-standard step-up and one-time fees.`,
    financial
      ? `4. Fill the refi block (new rate, term, closing costs, resulting monthly payment, and break-even months). Recommend only when break-even is reasonable AND the term is preserved.`
      : `4. Set switching_friction (low/medium/high) based on how hard the switch is for a typical consumer.`,
    `Record each via the record_offer tool with a real terms URL. When you've covered the realistic alternatives, call mark_exhausted. Begin now.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

interface RecordOfferInput {
  provider?: unknown;
  price_usd?: unknown;
  terms_url?: unknown;
  channel?: unknown;
  notes?: unknown;
  recommended?: unknown;
  equivalence?: unknown;
  normalized_cost?: unknown;
  refi?: unknown;
  switching_friction?: unknown;
  price_as_of?: unknown;
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function num(n: unknown): number | undefined {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? x : undefined;
}

function strArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
}

function parseEquivalence(raw: unknown): OfferEquivalence {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    keeps: strArray(obj.keeps),
    gives_up: strArray(obj.gives_up),
    gains: strArray(obj.gains),
    // Neutral prior when the agent omits a score so a bare offer still ranks.
    parity_score: obj.parity_score == null ? 0.6 : clamp01(obj.parity_score),
  };
}

function parseNormalizedCost(raw: unknown, fallbackMonthly: number): OfferNormalizedCost {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const horizon = Math.max(1, num(obj.horizon_months) ?? 12);
  const promoPrice = num(obj.promo_price_usd);
  const promoMonths = num(obj.promo_months);
  const standardPrice = num(obj.standard_price_usd);
  const oneTimeFees = num(obj.one_time_fees_usd);
  // Prefer the agent's effective monthly. When it's omitted, DERIVE it from the
  // promo→standard step-up + amortized one-time fees rather than falling back to
  // the sticker price — otherwise a 12-mo teaser gets ranked/displayed as the
  // real cost (Codex review finding). Sticker is the last resort.
  let effective = num(obj.effective_monthly_usd);
  if (effective == null) {
    if (promoPrice != null && standardPrice != null && promoMonths != null) {
      const pm = Math.min(Math.max(0, promoMonths), horizon);
      effective = (promoPrice * pm + standardPrice * (horizon - pm)) / horizon + (oneTimeFees ?? 0) / horizon;
    } else if (standardPrice != null) {
      effective = standardPrice + (oneTimeFees ?? 0) / horizon;
    } else {
      effective = fallbackMonthly + (oneTimeFees ?? 0) / horizon;
    }
  }
  return {
    // Floor at 0: a negative/garbage effective cost would inflate displayed
    // savings without bound (adversarial review finding).
    effective_monthly_usd: Math.max(0, effective),
    horizon_months: horizon,
    promo_price_usd: promoPrice != null ? Math.max(0, promoPrice) : undefined,
    promo_months: promoMonths,
    standard_price_usd: standardPrice != null ? Math.max(0, standardPrice) : undefined,
    one_time_fees_usd: oneTimeFees != null ? Math.max(0, oneTimeFees) : undefined,
  };
}

function parseRefi(raw: unknown): OfferRefi | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rate = num(obj.new_rate_pct);
  const payment = num(obj.monthly_payment_usd);
  if (rate == null && payment == null) return null;
  return {
    new_rate_pct: rate ?? 0,
    new_term_months: num(obj.new_term_months) ?? 0,
    closing_costs_usd: num(obj.closing_costs_usd) ?? 0,
    monthly_payment_usd: payment ?? 0,
    break_even_months: num(obj.break_even_months) ?? Number.POSITIVE_INFINITY,
    keeps_similar_term: obj.keeps_similar_term === true,
  };
}

function parseFriction(raw: unknown): SwitchingFriction {
  return raw === "low" || raw === "high" ? raw : "medium";
}

const FRICTION_WEIGHT: Record<SwitchingFriction, number> = {
  low: 1,
  medium: 1.5,
  high: 2.5,
};

/**
 * Composite rank for an offer. Net value rewards real (normalized) savings,
 * like-for-like parity, and confidence, and penalizes switching friction — so
 * a clean $40/mo win outranks a $5/mo save that needs re-qualification. A
 * mortgage refi scores zero unless it breaks even reasonably soon AND keeps a
 * similar term (a lower payment from re-amortizing to 30y is not a real win).
 */
export function netValueScore(offer: OfferRecord, baseline: Baseline): number {
  const eff = offer.normalized_cost?.effective_monthly_usd ?? offer.price_usd;
  const savings = baseline.current_price - eff;
  if (!(savings > 0) || baseline.current_price <= 0) return 0;
  if (isFinancialCategory(baseline.category)) {
    const refi = offer.refi;
    // Fail closed: a financial offer with no refi block can't be verified as a
    // real win (no break-even, no term preservation), so it never scores. A
    // lower effective monthly alone is not enough for a refi/balance transfer.
    if (!refi || refi.break_even_months > REFI_BREAK_EVEN_CAP_MONTHS || !refi.keeps_similar_term) {
      return 0;
    }
  }
  const savingsPct = Math.min(1, savings / baseline.current_price);
  const parity = clamp01(offer.equivalence?.parity_score ?? 0.6);
  const confidence = clamp01(offer.confidence ?? 0.5);
  return (savingsPct * parity * confidence) / FRICTION_WEIGHT[offer.switching_friction ?? "medium"];
}

/**
 * Bonsai is a bill-negotiation service, so when a search result surfaces
 * another bill-negotiation service ("switch to Goodbill!") we reject it
 * server-side regardless of what the agent decided. Matching is done on a
 * normalized provider name (lowercase, no whitespace/punct) so "Rocket
 * Money", "rocket-money", and "RocketMoney" all collapse to one key.
 */
const COMPETITOR_BLOCKLIST = new Set([
  // Bill-negotiation services
  "goodbill",
  "trim",
  "billfixers",
  "billcutterz",
  "billshark",
  "billtrim",
  "resolve",
  // Subscription / bill tracking apps that overlap our scope
  "truebill",
  "rocketmoney",
  "cushion",
  "hiatus",
  "buddy",
  "subby",
  "bobby",
  // Personal finance + bill-pay tools that pitch bill negotiation
  "moneylion",
  "chimebillpay",
  "quickenbills",
]);

function normalizeProviderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isCompetitorProvider(name: string): boolean {
  return COMPETITOR_BLOCKLIST.has(normalizeProviderName(name));
}

function coerceRecordOffer(
  input: RecordOfferInput,
  baseline: Baseline,
  alreadyRecorded: ReadonlySet<string>,
): { offer: OfferRecord; rejection: null } | { offer: null; rejection: string } {
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  const price = typeof input.price_usd === "number" ? input.price_usd : Number(input.price_usd);
  const termsUrl = typeof input.terms_url === "string" ? input.terms_url.trim() : "";
  const recommended = input.recommended === true;
  if (!provider || !termsUrl || !Number.isFinite(price) || price < 0) {
    return { offer: null, rejection: "rejected: invalid input (need provider, terms_url, non-negative price_usd)" };
  }
  // terms_url is untrusted LLM output that the UI renders into an <a href>.
  // Only allow http(s) so a prompt-injected `javascript:`/`data:` URL can't
  // become a clickable XSS in the authenticated session.
  if (!/^https?:\/\//i.test(termsUrl)) {
    return { offer: null, rejection: "rejected: terms_url must be an http(s) URL to a real pricing/terms page." };
  }
  const normalized = normalizeProviderName(provider);
  if (COMPETITOR_BLOCKLIST.has(normalized)) {
    return {
      offer: null,
      rejection: `rejected: ${provider} is a bill-negotiation competitor, not an alternative provider. Find a different company.`,
    };
  }
  if (alreadyRecorded.has(normalized)) {
    return {
      offer: null,
      rejection: `rejected: ${provider} is already recorded for this baseline. Move on to a different provider.`,
    };
  }
  const channel =
    input.channel === "email" || input.channel === "voice" ? input.channel : undefined;
  const notes = typeof input.notes === "string" ? input.notes : undefined;

  const equivalence = parseEquivalence(input.equivalence);
  const normalized_cost = parseNormalizedCost(input.normalized_cost, price);
  const refi = parseRefi(input.refi);
  const switching_friction = parseFriction(input.switching_friction);
  const price_as_of =
    typeof input.price_as_of === "string" && input.price_as_of.trim()
      ? input.price_as_of.trim()
      : new Date().toISOString().slice(0, 10);

  const offer: OfferRecord = {
    provider,
    price_usd: price,
    terms_url: termsUrl,
    channel,
    notes,
    recommended,
    // Normalized savings: effective monthly vs the baseline, not sticker price.
    savings_vs_baseline: baseline.current_price - normalized_cost.effective_monthly_usd,
    equivalence,
    normalized_cost,
    refi,
    // Unverified until the verify-offer pass runs; neutral prior so it ranks.
    confidence: 0.5,
    verified: false,
    price_as_of,
    switching_friction,
    net_value_score: 0,
  };
  offer.net_value_score = netValueScore(offer, baseline);
  return { offer, rejection: null };
}

/**
 * Run the offer hunt. Opens a Managed-Agents session, streams events, replies
 * to custom tool calls, and exits when the session reaches a terminal state.
 */
export async function runOfferHunt(opts: RunOfferHuntOpts): Promise<OfferHuntResult> {
  const client = opts.anthropic ?? new Anthropic();
  const { agent_id, environment_id } = await getOrCreateOfferAgent(client);
  const started_at = new Date().toISOString();

  const session = await client.beta.sessions.create({
    agent: agent_id,
    environment_id,
    title: `offer-hunt:${opts.baseline.label}`.slice(0, 256),
  });

  const offers: OfferRecord[] = [];
  // Tracks normalized provider names already recorded so we can reject
  // duplicates server-side (the prompt asks the agent to dedupe but we
  // can't trust it to remember across long sessions). Cleared per session.
  const recordedProviders = new Set<string>();
  let exhausted = false;
  const seenEventIds = new Set<string>();

  // Track in-flight custom-tool-use IDs so a reconnect can re-emit the
  // user.custom_tool_result and unblock the agent.
  const pendingToolResults: Anthropic.Beta.Sessions.BetaManagedAgentsEventParams[] = [];

  function processEvent(event: Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents): {
    done: boolean;
  } {
    if (seenEventIds.has(event.id)) return { done: false };
    seenEventIds.add(event.id);

    if (event.type === "agent.custom_tool_use") {
      if (event.name === "record_offer") {
        const result = coerceRecordOffer(event.input as RecordOfferInput, opts.baseline, recordedProviders);
        if (result.offer) {
          offers.push(result.offer);
          recordedProviders.add(normalizeProviderName(result.offer.provider));
        }
        pendingToolResults.push({
          type: "user.custom_tool_result",
          custom_tool_use_id: event.id,
          content: [{ type: "text", text: result.offer ? "recorded" : result.rejection }],
        });
      } else if (event.name === "mark_exhausted") {
        exhausted = true;
        pendingToolResults.push({
          type: "user.custom_tool_result",
          custom_tool_use_id: event.id,
          content: [{ type: "text", text: "exhausted_acknowledged" }],
        });
      }
      return { done: false };
    }

    if (event.type === "session.status_terminated") return { done: true };
    if (event.type === "session.status_idle") {
      // Bare idle while waiting on a custom_tool_result is NOT terminal —
      // we'll send the result and the session resumes.
      if (event.stop_reason.type === "requires_action") return { done: false };
      return { done: true };
    }
    return { done: false };
  }

  async function flushPendingResults(): Promise<void> {
    if (pendingToolResults.length === 0) return;
    const events = pendingToolResults.splice(0);
    await client.beta.sessions.events.send(session.id, { events });
  }

  try {
    // Stream-first ordering: open the SSE iterator BEFORE sending the kickoff,
    // otherwise the first events arrive buffered and we lose live ordering.
    let stream = await client.beta.sessions.events.stream(session.id);

    await client.beta.sessions.events.send(session.id, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: buildKickoffPrompt(opts.baseline) }],
        },
      ],
    });

    let done = false;
    while (!done) {
      try {
        for await (const event of stream) {
          const r = processEvent(event);
          if (pendingToolResults.length > 0) await flushPendingResults();
          if (r.done) {
            done = true;
            break;
          }
        }
        // Stream ended without a terminal event — retry once via list+stream.
        if (!done) {
          for await (const event of client.beta.sessions.events.list(session.id)) {
            const r = processEvent(event);
            if (r.done) {
              done = true;
              break;
            }
          }
          if (pendingToolResults.length > 0) await flushPendingResults();
          if (!done) stream = await client.beta.sessions.events.stream(session.id);
        }
      } catch (streamErr) {
        console.error(`[offer-hunt ${session.id}] stream error, reconnecting`, streamErr);
        // Reconnect with consolidation: replay everything via list (deduped
        // by seenEventIds), respond to any in-flight tool calls, then re-open
        // the live stream.
        for await (const event of client.beta.sessions.events.list(session.id)) {
          const r = processEvent(event);
          if (r.done) {
            done = true;
            break;
          }
        }
        if (pendingToolResults.length > 0) await flushPendingResults();
        if (!done) stream = await client.beta.sessions.events.stream(session.id);
      }
    }
  } finally {
    try {
      await client.beta.sessions.archive(session.id);
    } catch (err) {
      console.error(`[offer-hunt ${session.id}] archive failed`, err);
    }
  }

  // Cross-model verification pass (BONSAI_CROSSMODAL-gated, fail-open): scores
  // confidence + flags promo-only/eligibility-gated deals on recommended offers.
  // Confidence feeds the rank, so recompute net_value_score after it runs.
  await verifyOffers(offers, opts.baseline);
  for (const o of offers) {
    o.net_value_score = netValueScore(o, opts.baseline);
    // Clear the agent's recommended flag when our server-side gate scored it
    // zero (failed refi break-even/term, dropped coverage, promo-not-a-win).
    // Otherwise the persisted record keeps recommended=true and the Comparison
    // UI's Recommended tab shows a rejected offer with a Switch CTA (Codex).
    if (o.recommended && (o.net_value_score ?? 0) <= 0) o.recommended = false;
  }

  // Rank on net value, not lowest sticker price: a clean, like-for-like,
  // high-confidence, low-friction win should beat a thinly-cheaper option that
  // drops coverage or needs re-qualification. netValueScore already returns 0
  // for refis that don't break even / preserve term, so they can't win.
  const recommended = offers.filter(
    (o) => o.recommended && o.savings_vs_baseline > 0 && (o.net_value_score ?? 0) > 0,
  );
  let best: OfferRecord | null = null;
  for (const o of recommended) {
    if (!best || (o.net_value_score ?? 0) > (best.net_value_score ?? 0)) best = o;
  }

  let outcome: OfferHuntResult["outcome"];
  let headline: string;
  let total_monthly_savings: number | null = null;
  if (best) {
    outcome = "lower_price_found";
    total_monthly_savings = best.savings_vs_baseline;
    const eff = best.normalized_cost?.effective_monthly_usd ?? best.price_usd;
    headline = `Found ${best.provider} at ${fmt$(eff)} vs your ${fmt$(opts.baseline.current_price)} — saves ${fmt$(total_monthly_savings)}/mo.`;
  } else if (offers.length > 0) {
    outcome = "current_is_lowest";
    headline = `Checked ${offers.length} alternative${offers.length === 1 ? "" : "s"}. None cleanly beat your current ${fmt$(opts.baseline.current_price)}.`;
  } else {
    outcome = "exhausted_no_results";
    headline = exhausted
      ? `No credible alternatives found for ${opts.baseline.label}.`
      : `Hunt ended without recording any alternatives for ${opts.baseline.label}.`;
  }

  return {
    baseline: opts.baseline,
    offers,
    best,
    outcome,
    headline,
    total_monthly_savings,
    started_at,
    completed_at: new Date().toISOString(),
    run_id: opts.run_id,
  };
}

/** Persist a run to out/users/<id>/offers/{ts}-{baseline_slug}.json so the UI can list it. */
export function saveOfferHunt(result: OfferHuntResult): string {
  const dir = offersOutDir();
  mkdirSync(dir, { recursive: true });
  const slug = result.baseline.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  // Embed run_id in the filename when present so delete-bill can sweep
  // every file belonging to a deleted run via a glob (legacy files
  // without run_id stay parseable; projectOfferHistory filters orphans).
  const runFragment = result.run_id ? `-${result.run_id.replace(/[^a-zA-Z0-9_]/g, "")}` : "";
  const fname = `${Date.now()}${runFragment}-${slug || "offer"}.json`;
  const full = join(dir, fname);
  writeFileSync(full, JSON.stringify(result, null, 2), "utf8");
  return fname;
}

export function offersDir(): string {
  const dir = offersOutDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}


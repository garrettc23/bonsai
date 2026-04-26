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
  /** Optional extra context passed to the agent (medication name, plan tier, lab panel). */
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
  /** baseline.current_price - price_usd. Negative means worse than baseline. */
  savings_vs_baseline: number;
}

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
}

interface RunOfferHuntOpts {
  baseline: Baseline;
  /** @deprecated retained for caller compatibility — the agent handles its own stopping logic. */
  stop_on_first_win?: boolean;
  anthropic?: Anthropic;
}

function fmt$(n: number | null | undefined): string {
  if (n == null) return "$—";
  return `$${n.toFixed(2)}`;
}

function buildKickoffPrompt(baseline: Baseline): string {
  const cadence =
    baseline.category === "insurance_plan" || baseline.category === "dental"
      ? "monthly premium"
      : baseline.category === "hospital_bill"
        ? "current balance"
        : "per-month or per-procedure cost";
  return [
    `Hunt for cheaper alternatives to the following baseline.`,
    ``,
    `Baseline: ${baseline.label}`,
    `Category: ${baseline.category}`,
    `Current provider: ${baseline.current_provider}`,
    `Current price: ${fmt$(baseline.current_price)} (${cadence})`,
    baseline.specifics ? `Specifics: ${baseline.specifics}` : "",
    baseline.region ? `Region: ${baseline.region}` : "",
    ``,
    `Use web_search and web_fetch to find real, switchable alternatives. Record each via the record_offer tool with a real terms URL. When you've covered the realistic alternatives, call mark_exhausted. Begin researching alternatives now.`,
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
}

function coerceRecordOffer(input: RecordOfferInput, baseline: Baseline): OfferRecord | null {
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  const price = typeof input.price_usd === "number" ? input.price_usd : Number(input.price_usd);
  const termsUrl = typeof input.terms_url === "string" ? input.terms_url.trim() : "";
  const recommended = input.recommended === true;
  if (!provider || !termsUrl || !Number.isFinite(price) || price < 0) return null;
  const channel =
    input.channel === "email" || input.channel === "voice" ? input.channel : undefined;
  const notes = typeof input.notes === "string" ? input.notes : undefined;
  return {
    provider,
    price_usd: price,
    terms_url: termsUrl,
    channel,
    notes,
    recommended,
    savings_vs_baseline: baseline.current_price - price,
  };
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
        const offer = coerceRecordOffer(event.input as RecordOfferInput, opts.baseline);
        if (offer) offers.push(offer);
        pendingToolResults.push({
          type: "user.custom_tool_result",
          custom_tool_use_id: event.id,
          content: [{ type: "text", text: offer ? "recorded" : "rejected: invalid input" }],
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

  const recommended = offers.filter((o) => o.recommended && o.savings_vs_baseline > 0);
  let best: OfferRecord | null = null;
  for (const o of recommended) {
    if (!best || o.price_usd < best.price_usd) best = o;
  }

  let outcome: OfferHuntResult["outcome"];
  let headline: string;
  let total_monthly_savings: number | null = null;
  if (best) {
    outcome = "lower_price_found";
    total_monthly_savings = best.savings_vs_baseline;
    headline = `Found ${best.provider} at ${fmt$(best.price_usd)} vs your ${fmt$(opts.baseline.current_price)} — saves ${fmt$(total_monthly_savings)}/mo.`;
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

/**
 * Best-effort baseline derivation from an audit run's analyzer metadata.
 * Returns null when the audit doesn't map cleanly to a known offer category
 * — better to render no offers than to fire a useless hunt.
 */
export function deriveBaselineFromAudit(meta: {
  provider_name?: string;
  bill_kind?: string;
  bill_current_balance_due?: number;
}): Baseline | null {
  const provider = (meta.provider_name ?? "").trim();
  const price = typeof meta.bill_current_balance_due === "number" ? meta.bill_current_balance_due : 0;
  if (!provider || !Number.isFinite(price) || price <= 0) return null;
  const category = mapBillKindToCategory(meta.bill_kind);
  if (!category) return null;
  return {
    label: `${provider} ${category.replace(/_/g, " ")}`,
    category,
    current_provider: provider,
    current_price: price,
  };
}

function mapBillKindToCategory(billKind: string | undefined): OfferCategory | null {
  switch (billKind) {
    case "prescription":
    case "pharmacy":
      return "prescription";
    case "lab":
    case "lab_work":
      return "lab_work";
    case "imaging":
    case "radiology":
      return "imaging";
    case "infusion":
    case "specialty_infusion":
      return "specialty_infusion";
    case "dental":
      return "dental";
    case "hospital":
    case "hospital_bill":
      return "hospital_bill";
    case "urgent_care":
      return "urgent_care";
    case "insurance":
    case "insurance_plan":
      return "insurance_plan";
    case "house_insurance":
    case "homeowners":
      return "house_insurance";
    default:
      return null;
  }
}

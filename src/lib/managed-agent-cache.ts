/**
 * Managed-Agents agent cache.
 *
 * Anthropic's Managed Agents are persistent, versioned objects: you create one
 * and reference it by ID on every session. Re-creating the agent on every
 * offer hunt would burn quota and lose the per-version paper trail, so we
 * persist `(agent_id, environment_id)` in SQLite and only re-create when the
 * config we'd send changes.
 *
 * Keyed on a `purpose` string so future managed agents (negotiation, intake)
 * can share the same table. Today there is one purpose: "offer-hunt".
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { getDb } from "./db.ts";
import { loadSkill, renderSkill } from "../skills/_harness/skill-loader.ts";

const PURPOSE = "offer-hunt";
const AGENT_NAME = "Bonsai Offer Hunt";
const ENVIRONMENT_NAME = "bonsai-offer-hunt";
const MODEL: Anthropic.Beta.Agents.BetaManagedAgentsModel = "claude-opus-4-7";

// Fat-skill / thin-harness: the system prompt lives in src/skills/comparison-agent.md
// so it can be iterated without a code change. configHash() hashes this string, so
// editing the markdown auto-rebuilds the managed agent on the next hunt. The skill
// declares no inputs, so renderSkill({}) just returns the body verbatim.
//
// Guarded: this runs at module import, which is on the server's boot path. A
// missing/malformed skill file would otherwise throw and take the WHOLE server
// down at boot rather than degrading only the offer hunt. Fall back to a minimal
// inline prompt so the server still boots (and the hunt still does something
// sane) if the markdown is ever absent from a deploy.
const FALLBACK_SYSTEM_PROMPT =
  "You are Bonsai's comparison engine. Find cheaper, equivalent alternative providers for the user's bill using web_search and web_fetch. Record each via record_offer with a real http(s) terms_url, the keeps/gives_up/gains vs the baseline, and the true normalized monthly cost. Never recommend bill-negotiation or subscription-tracking services. Call mark_exhausted when done.";
let SYSTEM_PROMPT: string;
try {
  SYSTEM_PROMPT = renderSkill(loadSkill("comparison-agent"), {});
} catch (err) {
  console.error("[managed-agent-cache] failed to load comparison-agent skill, using fallback prompt", err);
  SYSTEM_PROMPT = FALLBACK_SYSTEM_PROMPT;
}

const TOOLS: Array<
  | Anthropic.Beta.Agents.BetaManagedAgentsAgentToolset20260401Params
  | Anthropic.Beta.Agents.BetaManagedAgentsCustomToolParams
> = [
  {
    type: "agent_toolset_20260401",
    default_config: { enabled: true },
    configs: [
      { name: "bash", enabled: false },
      { name: "write", enabled: false },
      { name: "edit", enabled: false },
    ],
  },
  {
    type: "custom",
    name: "record_offer",
    description:
      "Record an equivalent alternative the user could switch to, with what they keep/give up/gain and the true normalized cost.",
    input_schema: {
      type: "object",
      required: ["provider", "price_usd", "terms_url", "recommended"],
      properties: {
        provider: { type: "string", description: "Name of the alternative provider." },
        price_usd: { type: "number", description: "Advertised/sticker price in USD on the same cadence as baseline." },
        terms_url: {
          type: "string",
          description: "Public URL where the price/plan was verified.",
        },
        channel: { type: "string", enum: ["email", "voice"] },
        notes: { type: "string", description: "1–2 sentences on why this fits." },
        recommended: { type: "boolean" },
        price_as_of: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) the price was confirmed on the terms page.",
        },
        switching_friction: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "How hard the switch is for a typical consumer.",
        },
        equivalence: {
          type: "object",
          description: "What switching means relative to the baseline's equivalence dimensions.",
          properties: {
            keeps: { type: "array", items: { type: "string" }, description: "Dimensions matched or beaten." },
            gives_up: { type: "array", items: { type: "string" }, description: "Where the alternative is worse." },
            gains: { type: "array", items: { type: "string" }, description: "Where the alternative is better." },
            parity_score: { type: "number", description: "0–1: how like-for-like vs the baseline." },
          },
        },
        normalized_cost: {
          type: "object",
          description: "True total cost of ownership, not the sticker price.",
          properties: {
            effective_monthly_usd: { type: "number", description: "Blended monthly average over the horizon." },
            horizon_months: { type: "number", description: "Window the average covers (12–24)." },
            promo_price_usd: { type: "number" },
            promo_months: { type: "number" },
            standard_price_usd: { type: "number", description: "Price after the promo ends." },
            one_time_fees_usd: { type: "number", description: "Install/equipment/activation/transfer fees." },
          },
        },
        refi: {
          type: "object",
          description: "Financial categories only (mortgage refi, balance transfer). Break-even, not a price swap.",
          properties: {
            new_rate_pct: { type: "number" },
            new_term_months: { type: "number" },
            closing_costs_usd: { type: "number" },
            monthly_payment_usd: { type: "number" },
            break_even_months: { type: "number", description: "closing costs ÷ monthly savings." },
            keeps_similar_term: { type: "boolean" },
          },
        },
      },
    },
  },
  {
    type: "custom",
    name: "mark_exhausted",
    description: "Mark the category exhausted (no further alternatives worth recording).",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string" },
        current_provider_lowest: { type: "boolean" },
      },
    },
  },
];

const ENVIRONMENT_CONFIG: Anthropic.Beta.BetaCloudConfigParams = {
  type: "cloud",
  networking: { type: "unrestricted" },
};

function configHash(): string {
  // Stable JSON for fields the agent cares about. Object keys are stringified
  // in insertion order, but we only stringify primitives and arrays we
  // construct ourselves, so the order is deterministic.
  const canonical = JSON.stringify({
    model: MODEL,
    system: SYSTEM_PROMPT,
    name: AGENT_NAME,
    tools: TOOLS,
    environment: { name: ENVIRONMENT_NAME, config: ENVIRONMENT_CONFIG },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

interface CachedAgent {
  agent_id: string;
  environment_id: string;
}

export async function getOrCreateOfferAgent(
  client: Anthropic = new Anthropic(),
): Promise<CachedAgent> {
  const db = getDb();
  const hash = configHash();

  const row = db
    .prepare<{ agent_id: string; environment_id: string; agent_config_hash: string }, [string]>(
      "SELECT agent_id, environment_id, agent_config_hash FROM managed_agents WHERE purpose = ?",
    )
    .get(PURPOSE);

  if (row && row.agent_config_hash === hash) {
    return { agent_id: row.agent_id, environment_id: row.environment_id };
  }

  // Either first run or the config changed under us — create fresh and
  // overwrite the row. We do not archive the old agent: in-flight sessions
  // pinned to the old version keep working, and Anthropic-side cleanup is
  // out-of-band.
  const environment = await client.beta.environments.create({
    name: `${ENVIRONMENT_NAME}-${Date.now().toString(36)}`,
    config: ENVIRONMENT_CONFIG,
  });
  const agent = await client.beta.agents.create({
    name: AGENT_NAME,
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
  });

  db.prepare(
    `INSERT INTO managed_agents (purpose, agent_id, agent_config_hash, environment_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(purpose) DO UPDATE SET
       agent_id = excluded.agent_id,
       agent_config_hash = excluded.agent_config_hash,
       environment_id = excluded.environment_id,
       created_at = excluded.created_at`,
  ).run(PURPOSE, agent.id, hash, environment.id, Date.now());

  return { agent_id: agent.id, environment_id: environment.id };
}

/** Test hook — drop the cached row so the next call re-creates fresh. */
export function _resetManagedAgentCacheForTest(): void {
  getDb().prepare("DELETE FROM managed_agents WHERE purpose = ?").run(PURPOSE);
}

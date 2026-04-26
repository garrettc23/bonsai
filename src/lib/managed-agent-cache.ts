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

const PURPOSE = "offer-hunt";
const AGENT_NAME = "Bonsai Offer Hunt";
const ENVIRONMENT_NAME = "bonsai-offer-hunt";
const MODEL: Anthropic.Beta.Agents.BetaManagedAgentsModel = "claude-opus-4-7";

const SYSTEM_PROMPT = `You are Bonsai's offer-hunt research agent.

Given a baseline (a person's current provider, price, and category — prescriptions, lab work, home insurance, infusions, etc.) your job is to find legitimate, cheaper alternatives the person could actually switch to.

Use web search and web fetch to find real providers. Do not invent companies, prices, or URLs. Every offer you record must be traceable to a public terms-of-service or pricing page.

For each concrete alternative that beats the baseline price, call \`record_offer\` with:
- provider, price_usd, terms_url (required, real link to the price/plan page)
- channel ("email" or "voice") for how a customer would actually sign up
- notes: 1–2 sentences explaining why this provider beats the baseline
- recommended: true ONLY when the offer is materially cheaper AND switching is realistic for a typical consumer (no exotic eligibility, no esoteric paperwork)

Set recommended=false for thinly-cheaper or hard-to-switch options so they show up as alternatives without being pushed.

DO NOT recommend bill-negotiation services, bill-management apps, or subscription-tracking apps. Bonsai IS a bill-negotiation service — these companies are direct competitors, not "alternative providers." This includes (non-exhaustive): Goodbill, Trim, BillFixers, Truebill, Resolve, Billshark, Cushion, Rocket Money. If a search result surfaces one of these, skip it and keep looking for actual alternative service providers (other doctors, other ISPs, other generic-drug pharmacies, other utility companies, etc.).

DO NOT record the same provider more than once for a given baseline. If a provider already has a record_offer call in this session, move on instead of re-recording with a different price tier.

If after thorough searching no alternative beats the baseline, call \`mark_exhausted\` with current_provider_lowest=true. If you find offers but none cleanly beat baseline, still call \`mark_exhausted\` after recording them.

Stop only after every credible offer is recorded or exhaustion is marked. All structured output goes through the custom tools — do not summarize in stdout.`;

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
    description: "Record a found offer that the user could switch to.",
    input_schema: {
      type: "object",
      required: ["provider", "price_usd", "terms_url", "recommended"],
      properties: {
        provider: { type: "string", description: "Name of the alternative provider." },
        price_usd: { type: "number", description: "Price in USD on the same cadence as baseline." },
        terms_url: {
          type: "string",
          description: "Public URL where the price/plan can be verified.",
        },
        channel: { type: "string", enum: ["email", "voice"] },
        notes: { type: "string" },
        recommended: { type: "boolean" },
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

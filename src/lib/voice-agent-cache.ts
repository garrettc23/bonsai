/**
 * Per-user ElevenLabs agent cache.
 *
 * `getOrCreateAgent` returns the cached `agent_id` when the SHA-256 of the
 * generated agent config matches the row in `voice_agents`. On miss, it
 * calls `client.createAgent()` and upserts the row.
 *
 * Hashing the full config (system prompt, tool URLs, model, voice, floor)
 * means any change — patient name, disputed lines, webhook base URL — will
 * trigger a fresh agent on the next dial. ElevenLabs charges nothing extra
 * for additional agents, so over-creation is fine; under-creation (stale
 * agent talking about the wrong patient) is the bug we're avoiding.
 */
import { createHash } from "node:crypto";
import {
  generateAgentConfig,
  type AgentConfigOpts,
  type ElevenLabsAgentConfig,
} from "../voice/agent-config.ts";
import { ElevenLabsClient } from "../voice/client.ts";
import { getDb } from "./db.ts";

export interface CachedAgent {
  agent_id: string;
  agent_config_hash: string;
  created_at: number;
  cached: boolean;
  config: ElevenLabsAgentConfig;
}

interface VoiceAgentRow {
  user_id: string;
  agent_id: string;
  agent_config_hash: string;
  created_at: number;
}

export function hashAgentConfig(config: ElevenLabsAgentConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export interface GetOrCreateAgentOpts extends AgentConfigOpts {
  /** Override for tests. Defaults to a fresh ElevenLabsClient(). */
  client?: { createAgent: ElevenLabsClient["createAgent"] };
}

export async function getOrCreateAgent(
  user: { id: string },
  opts: GetOrCreateAgentOpts,
): Promise<CachedAgent> {
  const { client: clientOverride, ...configOpts } = opts;
  const config = generateAgentConfig(configOpts);
  const hash = hashAgentConfig(config);

  const db = getDb();
  const row = db
    .prepare(`SELECT user_id, agent_id, agent_config_hash, created_at FROM voice_agents WHERE user_id = ?`)
    .get(user.id) as VoiceAgentRow | undefined;

  if (row && row.agent_config_hash === hash) {
    return {
      agent_id: row.agent_id,
      agent_config_hash: row.agent_config_hash,
      created_at: row.created_at,
      cached: true,
      config,
    };
  }

  const client = clientOverride ?? new ElevenLabsClient();
  const created = await client.createAgent(config);
  const now = Date.now();
  db.prepare(
    `INSERT INTO voice_agents (user_id, agent_id, agent_config_hash, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       agent_config_hash = excluded.agent_config_hash,
       created_at = excluded.created_at`,
  ).run(user.id, created.agent_id, hash, now);

  return {
    agent_id: created.agent_id,
    agent_config_hash: hash,
    created_at: now,
    cached: false,
    config,
  };
}

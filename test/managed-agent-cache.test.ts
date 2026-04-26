/**
 * Tests for src/lib/managed-agent-cache.ts.
 *
 * The cache decides whether each offer-hunt run reuses the existing
 * managed-agent + environment or provisions fresh ones — the wrong answer
 * either burns Anthropic-side quota (false negatives) or pins runs to a
 * stale system prompt (false positives). We mock the SDK at the
 * `client.beta.{environments,agents}.create` boundary, point at a tmpdir
 * SQLite DB, and verify:
 *
 *   - First call provisions both, persists the row, and returns the new IDs
 *   - Second call returns the cached IDs without re-provisioning
 *   - When the table row exists but the hash mismatches (config drift, e.g.
 *     a system-prompt edit shipped between deploys), the cache re-provisions
 *
 * Run: bun test test/managed-agent-cache.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import {
  _resetManagedAgentCacheForTest,
  getOrCreateOfferAgent,
} from "../src/lib/managed-agent-cache.ts";

const TEST_DB_DIR = join(tmpdir(), `bonsai-test-${process.pid}-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, "bonsai.db");

function nukeOut(): void {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  _resetDbForTest();
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB_PATH;
  mkdirSync(TEST_DB_DIR, { recursive: true });
  nukeOut();
});

afterAll(() => {
  nukeOut();
  delete process.env.BONSAI_DB_PATH;
});

beforeEach(() => {
  // Re-create the DB so tables come back after nukeOut().
  _resetDbForTest();
  getDb();
  _resetManagedAgentCacheForTest();
});

afterEach(() => {
  _resetManagedAgentCacheForTest();
});

interface CountingClient {
  client: Anthropic;
  envCreates: () => number;
  agentCreates: () => number;
}

function makeMockClient(envId = "env_test", agentId = "agent_test"): CountingClient {
  let envCalls = 0;
  let agentCalls = 0;
  const client = {
    beta: {
      environments: {
        create: async () => {
          envCalls += 1;
          return { id: envId, name: "bonsai-offer-hunt", type: "environment" };
        },
      },
      agents: {
        create: async () => {
          agentCalls += 1;
          return { id: agentId, version: 1, name: "Bonsai Offer Hunt", type: "agent" };
        },
      },
    },
  } as unknown as Anthropic;
  return {
    client,
    envCreates: () => envCalls,
    agentCreates: () => agentCalls,
  };
}

describe("getOrCreateOfferAgent", () => {
  test("first call provisions environment + agent and persists", async () => {
    const m = makeMockClient("env_one", "agent_one");
    const result = await getOrCreateOfferAgent(m.client);

    expect(result.environment_id).toBe("env_one");
    expect(result.agent_id).toBe("agent_one");
    expect(m.envCreates()).toBe(1);
    expect(m.agentCreates()).toBe(1);

    const row = getDb()
      .prepare<{ purpose: string; agent_id: string; environment_id: string }, []>(
        "SELECT purpose, agent_id, environment_id FROM managed_agents",
      )
      .get();
    expect(row?.purpose).toBe("offer-hunt");
    expect(row?.agent_id).toBe("agent_one");
  });

  test("second call with same config returns cached IDs without re-provisioning", async () => {
    const m1 = makeMockClient("env_first", "agent_first");
    const r1 = await getOrCreateOfferAgent(m1.client);
    expect(m1.envCreates()).toBe(1);

    // A different mock — if the cache works, neither create() runs again.
    const m2 = makeMockClient("env_second", "agent_second");
    const r2 = await getOrCreateOfferAgent(m2.client);

    expect(r2.environment_id).toBe(r1.environment_id);
    expect(r2.agent_id).toBe(r1.agent_id);
    expect(m2.envCreates()).toBe(0);
    expect(m2.agentCreates()).toBe(0);
  });

  test("hash mismatch (manual row corruption) triggers re-provision", async () => {
    const m1 = makeMockClient("env_v1", "agent_v1");
    await getOrCreateOfferAgent(m1.client);

    // Simulate config drift between deploys by overwriting the row's hash.
    getDb()
      .prepare("UPDATE managed_agents SET agent_config_hash = 'stale' WHERE purpose = 'offer-hunt'")
      .run();

    const m2 = makeMockClient("env_v2", "agent_v2");
    const r2 = await getOrCreateOfferAgent(m2.client);

    expect(r2.environment_id).toBe("env_v2");
    expect(r2.agent_id).toBe("agent_v2");
    expect(m2.envCreates()).toBe(1);
    expect(m2.agentCreates()).toBe(1);
  });
});

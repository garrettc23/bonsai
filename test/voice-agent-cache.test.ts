/**
 * Voice agent cache tests:
 *   - first call creates a fresh ElevenLabs agent and writes the row
 *   - second call with the same config hits the cache (no createAgent call)
 *   - mutated config (different system prompt, floor, etc.) busts the cache
 *
 * createAgent is mocked via the `client` injection on getOrCreateAgent —
 * no network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import { getOrCreateAgent } from "../src/lib/voice-agent-cache.ts";
import { createUser } from "../src/lib/auth.ts";
import type { AnalyzerResult } from "../src/types.ts";

const TEST_DIR = join(tmpdir(), `bonsai-voice-cache-${process.pid}-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "bonsai.db");

function fakeAnalyzer(overrides?: Partial<AnalyzerResult["metadata"]>): AnalyzerResult {
  return {
    metadata: {
      bill_kind: "medical",
      patient_name: "Test Patient",
      provider_name: "Test Hospital",
      provider_billing_address: null,
      account_number: "ACCT-1",
      claim_number: null,
      date_of_service: "2026-01-15",
      insurer_name: null,
      bill_current_balance_due: 1000,
      eob_patient_responsibility: 200,
      ...overrides,
    },
    errors: [],
    summary: {
      high_confidence_total: 0,
      worth_reviewing_total: 0,
      bill_total_disputed: 0,
      headline: "No high-confidence findings on this bill.",
    },
    grounding_failures: [],
    meta: { model: "test", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB;
  process.env.BONSAI_DATA_DIR = TEST_DIR;
});

afterAll(() => {
  delete process.env.BONSAI_DB_PATH;
  delete process.env.BONSAI_DATA_DIR;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  _resetDbForTest();
  getDb();
});

describe("getOrCreateAgent", () => {
  test("first call calls createAgent and writes the row", async () => {
    const user = await createUser(`first-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    let calls = 0;
    const client = {
      async createAgent() {
        calls += 1;
        return { agent_id: "agent-A" };
      },
    };
    const result = await getOrCreateAgent(user, {
      result: fakeAnalyzer(),
      webhook_base_url: "https://example.test/webhooks/voice",
      webhook_secret: "secret",
      client,
    });
    expect(calls).toBe(1);
    expect(result.cached).toBe(false);
    expect(result.agent_id).toBe("agent-A");

    const row = getDb().prepare(`SELECT user_id, agent_id, agent_config_hash FROM voice_agents WHERE user_id = ?`).get(user.id);
    expect(row).toBeTruthy();
  });

  test("second call with same config hits the cache (no createAgent)", async () => {
    const user = await createUser(`second-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    let calls = 0;
    const client = {
      async createAgent() {
        calls += 1;
        return { agent_id: `agent-${calls}` };
      },
    };
    const opts = {
      result: fakeAnalyzer(),
      webhook_base_url: "https://example.test/webhooks/voice",
      webhook_secret: "secret",
      client,
    } as const;
    const first = await getOrCreateAgent(user, opts);
    const second = await getOrCreateAgent(user, opts);
    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.agent_id).toBe(first.agent_id);
    expect(second.agent_config_hash).toBe(first.agent_config_hash);
  });

  test("mutated config busts the cache and re-creates the agent", async () => {
    const user = await createUser(`bust-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    let calls = 0;
    const client = {
      async createAgent() {
        calls += 1;
        return { agent_id: `agent-${calls}` };
      },
    };
    const optsA = {
      result: fakeAnalyzer({ patient_name: "Original Name" }),
      webhook_base_url: "https://example.test/webhooks/voice",
      webhook_secret: "secret",
      client,
    } as const;
    const optsB = {
      result: fakeAnalyzer({ patient_name: "Different Name" }),
      webhook_base_url: "https://example.test/webhooks/voice",
      webhook_secret: "secret",
      client,
    } as const;
    const first = await getOrCreateAgent(user, optsA);
    const second = await getOrCreateAgent(user, optsB);
    expect(calls).toBe(2);
    expect(second.cached).toBe(false);
    expect(second.agent_id).not.toBe(first.agent_id);
    expect(second.agent_config_hash).not.toBe(first.agent_config_hash);

    const row = getDb()
      .prepare(`SELECT agent_id, agent_config_hash FROM voice_agents WHERE user_id = ?`)
      .get(user.id) as { agent_id: string; agent_config_hash: string } | undefined;
    expect(row?.agent_id).toBe(second.agent_id);
    expect(row?.agent_config_hash).toBe(second.agent_config_hash);
  });
});

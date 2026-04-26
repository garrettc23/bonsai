/**
 * Voice cost-control tests:
 *   - estimateCallCost math at default range and explicit minutes
 *   - per-user rate limit triggers at the 6th call (default cap = 5)
 *   - operator daily budget cap blocks dial when (today + max) > cap
 *
 * No network: VOICE_DRY_RUN=true short-circuits before startOutboundCall,
 * and an injected agent_client returns a fixed agent_id so we never hit
 * ElevenLabs's createAgent endpoint either.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_MINUTES,
  DEFAULT_MIN_MINUTES,
  RATE_ANTHROPIC_PER_MIN,
  RATE_ELEVENLABS_PER_MIN,
  RATE_TWILIO_PER_MIN,
  estimateCallCost,
} from "../src/lib/voice-cost-estimate.ts";
import { _resetRateLimitForTest } from "../src/lib/rate-limit.ts";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import { dialVoiceForUser } from "../src/server/voice-dial.ts";
import { ensureUserDirs, userPaths } from "../src/lib/user-paths.ts";
import { withUserContext } from "../src/lib/user-context.ts";
import { createUser } from "../src/lib/auth.ts";
import { addSpend } from "../src/lib/voice-spend.ts";
import type { AnalyzerResult } from "../src/types.ts";

const TEST_DIR = join(tmpdir(), `bonsai-voice-cost-${process.pid}-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "bonsai.db");

function fakeAnalyzer(): AnalyzerResult {
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
    },
    errors: [],
    summary: {
      high_confidence_total: 0,
      worth_reviewing_total: 0,
      bill_total_disputed: 0,
      headline: "No high-confidence findings on this bill.",
    },
    grounding_failures: [],
    meta: {
      model: "test",
      input_tokens: 0,
      output_tokens: 0,
      elapsed_ms: 0,
      tool_turns: 0,
    },
  };
}

const stubAgentClient = {
  async createAgent() {
    return { agent_id: "agent-test" };
  },
};

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB;
  process.env.BONSAI_DATA_DIR = TEST_DIR;
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_TWILIO_PHONE_NUMBER_ID = "phone-test";
  process.env.ELEVENLABS_WEBHOOK_BASE = "https://example.test";
  process.env.ELEVENLABS_WEBHOOK_SECRET = "secret-test";
  process.env.VOICE_DRY_RUN = "true";
});

afterAll(() => {
  delete process.env.BONSAI_DB_PATH;
  delete process.env.BONSAI_DATA_DIR;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_TWILIO_PHONE_NUMBER_ID;
  delete process.env.ELEVENLABS_WEBHOOK_BASE;
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  delete process.env.VOICE_DRY_RUN;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  _resetDbForTest();
  _resetRateLimitForTest();
  delete process.env.BONSAI_VOICE_DAILY_LIMIT;
  delete process.env.BONSAI_VOICE_DAILY_BUDGET_USD;
  getDb(); // create schema
});

describe("estimateCallCost", () => {
  test("default range covers DEFAULT_MIN_MINUTES to DEFAULT_MAX_MINUTES", () => {
    const est = estimateCallCost();
    const perMin = RATE_TWILIO_PER_MIN + RATE_ELEVENLABS_PER_MIN + RATE_ANTHROPIC_PER_MIN;
    expect(est.min_usd).toBeCloseTo(perMin * DEFAULT_MIN_MINUTES, 2);
    expect(est.max_usd).toBeCloseTo(perMin * DEFAULT_MAX_MINUTES, 2);
    expect(est.components.twilio).toBeCloseTo(RATE_TWILIO_PER_MIN * DEFAULT_MAX_MINUTES, 2);
    expect(est.components.elevenlabs).toBeCloseTo(RATE_ELEVENLABS_PER_MIN * DEFAULT_MAX_MINUTES, 2);
    expect(est.components.anthropic).toBeCloseTo(RATE_ANTHROPIC_PER_MIN * DEFAULT_MAX_MINUTES, 2);
  });

  test("explicit duration produces a point estimate (min == max)", () => {
    const est = estimateCallCost(10);
    const perMin = RATE_TWILIO_PER_MIN + RATE_ELEVENLABS_PER_MIN + RATE_ANTHROPIC_PER_MIN;
    expect(est.min_usd).toBe(est.max_usd);
    expect(est.min_usd).toBeCloseTo(perMin * 10, 2);
  });

  test("zero duration is zero cost", () => {
    const est = estimateCallCost(0);
    expect(est.min_usd).toBe(0);
    expect(est.max_usd).toBe(0);
  });
});

describe("dial gates", () => {
  test("per-user voice rate limit blocks the 6th call (default cap 5)", async () => {
    const user = await createUser(`rl-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    const analyzer = fakeAnalyzer();
    const dialOnce = () =>
      withUserContext(user, () =>
        dialVoiceForUser(user, {
          run_id: "run-1",
          analyzer,
          provider_phone: "+15555550100",
          agent_client: stubAgentClient,
        }),
      );
    for (let i = 0; i < 5; i++) {
      const res = await dialOnce();
      expect(res.ok).toBe(true);
    }
    const blocked = await dialOnce();
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected blocked");
    expect(blocked.status).toBe(429);
    expect(blocked.error).toMatch(/limit/i);
  });

  test("BONSAI_VOICE_DAILY_LIMIT override is honored", async () => {
    process.env.BONSAI_VOICE_DAILY_LIMIT = "2";
    const user = await createUser(`rl2-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    const analyzer = fakeAnalyzer();
    const dialOnce = () =>
      withUserContext(user, () =>
        dialVoiceForUser(user, {
          run_id: "run-1",
          analyzer,
          provider_phone: "+15555550100",
          agent_client: stubAgentClient,
        }),
      );
    expect((await dialOnce()).ok).toBe(true);
    expect((await dialOnce()).ok).toBe(true);
    const blocked = await dialOnce();
    expect(blocked.ok).toBe(false);
  });

  test("operator daily budget cap blocks dial when (today + max_estimate) > cap", async () => {
    process.env.BONSAI_VOICE_DAILY_BUDGET_USD = "2.5"; // tight: any spend at all + max-estimate exceeds
    const user = await createUser(`bud-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    addSpend(0.1);
    const analyzer = fakeAnalyzer();
    const blocked = await withUserContext(user, () =>
      dialVoiceForUser(user, {
        run_id: "run-budget",
        analyzer,
        provider_phone: "+15555550100",
        agent_client: stubAgentClient,
      }),
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected blocked");
    expect(blocked.status).toBe(429);
    expect(blocked.error).toMatch(/budget/i);
  });

  test("missing provider_phone returns 400", async () => {
    const user = await createUser(`np-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    const analyzer = fakeAnalyzer();
    const res = await withUserContext(user, () =>
      dialVoiceForUser(user, {
        run_id: "run-no-phone",
        analyzer,
        provider_phone: "",
        agent_client: stubAgentClient,
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected fail");
    expect(res.status).toBe(400);
  });

  test("dry-run path returns synthetic conversation_id without calling startOutboundCall", async () => {
    const user = await createUser(`dr-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    const analyzer = fakeAnalyzer();
    const result = await withUserContext(user, () =>
      dialVoiceForUser(user, {
        run_id: "run-dry",
        analyzer,
        provider_phone: "+15555550100",
        agent_client: stubAgentClient,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dry_run).toBe(true);
    expect(result.conversation_id).toMatch(/^dryrun_/);
    expect(result.agent_id).toBe("agent-test");
  });
});

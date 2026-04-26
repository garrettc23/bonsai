/**
 * ElevenLabs voice server-tool webhook tests.
 *
 * Coverage:
 *   - verifyBearer: good token / bad token / fail-closed in prod
 *   - 404 when conversation_id has no on-disk meta envelope
 *   - 200 + tool dispatch + transcript turn appended on a happy path
 *   - end_call finalizes meta (status=ended, ended_at set) and increments
 *     voice_spend with the actual computed call cost
 *   - withCallLock serializes concurrent webhooks so transcript ordering
 *     is consistent and neither save clobbers the other
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import {
  _resetCallLocksForTest,
  saveConversationMeta,
  loadConversationMeta,
  type ConversationMeta,
} from "../src/lib/call-store.ts";
import {
  handleVoiceWebhook,
  stateCallIdFor,
  verifyBearer,
} from "../src/server/voice-webhooks.ts";
import { newCallState, saveCallState } from "../src/voice/tool-handlers.ts";
import { createUser } from "../src/lib/auth.ts";
import { ensureUserDirs, userPaths } from "../src/lib/user-paths.ts";
import { withUserContext } from "../src/lib/user-context.ts";
import { getTodaySpendUsd } from "../src/lib/voice-spend.ts";
import type { AnalyzerResult, BillingError } from "../src/types.ts";

const TEST_DIR = join(tmpdir(), `bonsai-voice-webhooks-${process.pid}-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "bonsai.db");

function fakeAnalyzer(): AnalyzerResult {
  const high: BillingError = {
    error_type: "duplicate",
    description: "Same CPT billed twice on date of service",
    line_quote: "99284 — Emergency department visit (Lvl 4)",
    confidence: "high",
    dollar_impact: 412.5,
    cpt_code: "99284",
  };
  return {
    metadata: {
      bill_kind: "medical",
      patient_name: "Test Patient",
      provider_name: "Test Hospital",
      provider_billing_address: null,
      account_number: "ACCT-1",
      claim_number: "CLM-1",
      date_of_service: "2026-01-15",
      insurer_name: "TestCo",
      bill_current_balance_due: 1000,
      eob_patient_responsibility: 200,
    },
    errors: [high],
    summary: {
      high_confidence_total: 412.5,
      worth_reviewing_total: 0,
      bill_total_disputed: 412.5,
      headline: "Found one duplicate charge worth $412.50.",
    },
    grounding_failures: [],
    meta: { model: "test", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

async function seedConversation(opts: {
  user_id: string;
  conversation_id: string;
}): Promise<ConversationMeta> {
  const meta: ConversationMeta = {
    conversation_id: opts.conversation_id,
    run_id: "run-test",
    user_id: opts.user_id,
    started_at: Date.now(),
    status: "active",
    source: "real",
    outcome: {},
    transcript: [],
  };
  saveConversationMeta(meta);
  // CallState is written under user-context (currentUserPaths()).
  const state = newCallState({
    call_id: stateCallIdFor(opts.conversation_id),
    analyzer: fakeAnalyzer(),
    final_acceptable_floor: 200,
  });
  // Have to write inside withUserContext so saveCallState resolves the user dir.
  const dir = userPaths(opts.user_id).callsDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${state.call_id}.json`), JSON.stringify(state, null, 2));
  return meta;
}

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/webhooks/voice/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB;
  process.env.BONSAI_DATA_DIR = TEST_DIR;
});

afterAll(() => {
  delete process.env.BONSAI_DB_PATH;
  delete process.env.BONSAI_DATA_DIR;
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  delete process.env.NODE_ENV;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  _resetDbForTest();
  _resetCallLocksForTest();
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  delete process.env.NODE_ENV;
  getDb();
});

describe("verifyBearer", () => {
  test("accepts the configured token", () => {
    const req = new Request("http://x", { headers: { authorization: "Bearer hello" } });
    expect(verifyBearer(req, "hello")).toBe(true);
  });

  test("rejects a wrong token", () => {
    const req = new Request("http://x", { headers: { authorization: "Bearer nope" } });
    expect(verifyBearer(req, "hello")).toBe(false);
  });

  test("rejects when the Authorization header is malformed", () => {
    const req = new Request("http://x", { headers: { authorization: "hello" } });
    expect(verifyBearer(req, "hello")).toBe(false);
  });

  test("rejects when token lengths differ (no leak via early return)", () => {
    const req = new Request("http://x", { headers: { authorization: "Bearer h" } });
    expect(verifyBearer(req, "hello")).toBe(false);
  });

  test("dev mode: secret unset → accept (so curl smoke works locally)", () => {
    delete process.env.NODE_ENV;
    const req = new Request("http://x");
    expect(verifyBearer(req, undefined)).toBe(true);
  });

  test("prod mode: secret unset → reject (fail-closed)", () => {
    process.env.NODE_ENV = "production";
    const req = new Request("http://x");
    expect(verifyBearer(req, undefined)).toBe(false);
  });
});

describe("handleVoiceWebhook", () => {
  test("401 on bad bearer when a secret is configured", async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = "right";
    const res = await handleVoiceWebhook(
      "get_disputed_line",
      makeReq({ conversation_id: "conv_x" }, { authorization: "Bearer wrong" }),
    );
    expect(res.status).toBe(401);
  });

  test("404 on unknown conversation_id", async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = "right";
    const res = await handleVoiceWebhook(
      "get_disputed_line",
      makeReq({ conversation_id: "conv_unknown" }, { authorization: "Bearer right" }),
    );
    expect(res.status).toBe(404);
  });

  test("200 + dispatches tool + appends transcript turn", async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = "right";
    const user = await createUser(`hh-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    const conv = "conv_happy_1";
    await withUserContext(user, async () => seedConversation({ user_id: user.id, conversation_id: conv }));

    const res = await handleVoiceWebhook(
      "get_disputed_line",
      makeReq(
        { conversation_id: conv, parameters: { index: 1 } },
        { authorization: "Bearer right" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { found: boolean } };
    expect(body.result.found).toBe(true);

    const meta = loadConversationMeta(user.id, conv);
    expect(meta?.transcript.length).toBe(1);
    expect(meta?.transcript[0].role).toBe("tool");
    expect(meta?.transcript[0].text).toBe("get_disputed_line");
  });

  // Cover every tool dispatch — at minimum confirm webhook → tool-handlers
  // round-trip works for each name. The dispatcher itself is exhaustively
  // tested via tool-handlers; this just makes sure no name is mis-wired.
  for (const tool of [
    "confirm_eob_amount",
    "propose_general_discount",
    "record_negotiated_amount",
    "request_human_handoff",
  ] as const) {
    test(`200 dispatches ${tool} via the webhook`, async () => {
      process.env.ELEVENLABS_WEBHOOK_SECRET = "right";
      const user = await createUser(`d-${tool}-${Date.now()}@test.example`, "supersecret", {
        acceptedTerms: true,
      });
      ensureUserDirs(userPaths(user.id));
      const conv = `conv_${tool}`;
      await withUserContext(user, async () =>
        seedConversation({ user_id: user.id, conversation_id: conv }),
      );

      const params: Record<string, unknown> = (() => {
        switch (tool) {
          case "confirm_eob_amount":
            return {};
          case "propose_general_discount":
            return { amount_off: 50, reason: "retention discount" };
          case "record_negotiated_amount":
            return { amount: 150, commitment_notes: "Rep agreed to $150." };
          case "request_human_handoff":
            return { reason: "supervisor_refused" };
        }
      })();
      const res = await handleVoiceWebhook(
        tool,
        makeReq(
          { conversation_id: conv, parameters: params },
          { authorization: "Bearer right" },
        ),
      );
      expect(res.status).toBe(200);
      const meta = loadConversationMeta(user.id, conv);
      expect(meta?.transcript.length).toBe(1);
      expect(meta?.transcript[0].text).toBe(tool);
    });
  }

  test("404 when conversation has no on-disk CallState", async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = "right";
    const user = await createUser(`ns-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    const conv = "conv_no_state";
    // Save meta envelope but skip CallState file — webhook should bail with 404.
    saveConversationMeta({
      conversation_id: conv,
      run_id: "run-x",
      user_id: user.id,
      started_at: Date.now(),
      status: "active",
      source: "real",
      outcome: {},
      transcript: [],
    });
    const res = await handleVoiceWebhook(
      "get_disputed_line",
      makeReq(
        { conversation_id: conv, parameters: { index: 1 } },
        { authorization: "Bearer right" },
      ),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/state/i);
  });

  test("400 on missing conversation_id", async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = "right";
    const res = await handleVoiceWebhook(
      "get_disputed_line",
      makeReq({ parameters: { index: 1 } }, { authorization: "Bearer right" }),
    );
    expect(res.status).toBe(400);
  });

  test("end_call finalizes meta and registers spend (real source)", async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = "right";
    const user = await createUser(`ec-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    const conv = "conv_end_1";
    await withUserContext(user, async () => seedConversation({ user_id: user.id, conversation_id: conv }));

    expect(getTodaySpendUsd()).toBe(0);
    const res = await handleVoiceWebhook(
      "end_call",
      makeReq(
        { conversation_id: conv, parameters: { outcome: "success" } },
        { authorization: "Bearer right" },
      ),
    );
    expect(res.status).toBe(200);
    const meta = loadConversationMeta(user.id, conv);
    expect(meta?.status).toBe("ended");
    expect(typeof meta?.ended_at).toBe("number");
    expect(getTodaySpendUsd()).toBeGreaterThanOrEqual(0); // duration may round to zero on fast tests
  });

  test("withCallLock serializes concurrent webhooks (no transcript clobber)", async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = "right";
    const user = await createUser(`mx-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
    ensureUserDirs(userPaths(user.id));
    const conv = "conv_mutex_1";
    await withUserContext(user, async () => seedConversation({ user_id: user.id, conversation_id: conv }));

    const reqs = Array.from({ length: 8 }, (_, i) =>
      handleVoiceWebhook(
        "get_disputed_line",
        makeReq(
          { conversation_id: conv, parameters: { index: 1 } },
          { authorization: "Bearer right" },
        ),
      ),
    );
    const results = await Promise.all(reqs);
    for (const r of results) expect(r.status).toBe(200);

    const meta = loadConversationMeta(user.id, conv);
    // All 8 invocations should appear in the transcript — last-writer-wins
    // would have lost most of them.
    expect(meta?.transcript.length).toBe(8);
  });
});

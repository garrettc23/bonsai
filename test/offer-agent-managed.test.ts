/**
 * Tests for the Managed-Agents-backed offer hunt loop.
 *
 * The hunt's behavior is event-driven: an SSE stream of agent.* events
 * arrives, the loop dispatches custom-tool calls back as user.custom_tool_*
 * events, and exits when the session goes terminal. We mock the SDK at the
 * client.beta.{sessions,environments,agents} boundary, script an event
 * sequence per test, and assert the resulting OfferHuntResult shape and
 * outcome. Real network calls would be flaky and expensive; the loop's
 * correctness is in the dispatch logic, not the SDK.
 *
 * Run: bun test test/offer-agent-managed.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import { _resetManagedAgentCacheForTest } from "../src/lib/managed-agent-cache.ts";
import { runOfferHunt, type Baseline } from "../src/offer-agent.ts";

const TEST_DB_DIR = join(tmpdir(), `bonsai-offer-agent-${process.pid}-${Date.now()}`);
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
  _resetDbForTest();
  getDb();
  _resetManagedAgentCacheForTest();
});

afterEach(() => {
  _resetManagedAgentCacheForTest();
});

type ScriptedEvent = Record<string, unknown> & { id: string; type: string };

interface MockClient {
  client: Anthropic;
  sentEventBatches: Array<Array<Record<string, unknown>>>;
  archivedSessions: string[];
}

/**
 * Build a fake Anthropic client that yields the supplied events on the SSE
 * stream and captures every events.send() payload + sessions.archive() call.
 * The streamed events run as a self-iterating generator so the runOfferHunt
 * loop sees them in order.
 */
function makeMockClient(events: ScriptedEvent[]): MockClient {
  const sentEventBatches: Array<Array<Record<string, unknown>>> = [];
  const archivedSessions: string[] = [];

  const client = {
    beta: {
      environments: {
        create: async () => ({ id: "env_test", name: "bonsai-offer-hunt", type: "environment" }),
      },
      agents: {
        create: async () => ({ id: "agent_test", version: 1, name: "Bonsai Offer Hunt", type: "agent" }),
      },
      sessions: {
        create: async () => ({
          id: "sesn_test_abc",
          status: "running",
          type: "session",
          title: "offer-hunt:test",
        }),
        archive: async (sessionId: string) => {
          archivedSessions.push(sessionId);
        },
        events: {
          stream: async () => {
            const queue = [...events];
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    const value = queue.shift();
                    return value ? { value, done: false } : { value: undefined, done: true };
                  },
                };
              },
            };
          },
          send: async (
            _sessionId: string,
            params: { events: Array<Record<string, unknown>> },
          ) => {
            sentEventBatches.push(params.events);
            return { type: "event_send_response", events: [] };
          },
          list: async () => {
            // Auto-pagination iterable. Empty for the happy path; specific
            // tests that exercise reconnect override this on the spot.
            return {
              data: [],
              [Symbol.asyncIterator]() {
                return { async next() { return { value: undefined, done: true }; } };
              },
            };
          },
        },
      },
    },
  } as unknown as Anthropic;

  return { client, sentEventBatches, archivedSessions };
}

const baseline: Baseline = {
  label: "Acme Atorvastatin 30-day",
  category: "prescription",
  current_provider: "Acme Pharmacy",
  current_price: 80,
  specifics: "atorvastatin 20mg, 30-day supply",
  region: "94110",
};

describe("runOfferHunt — Managed Agents loop", () => {
  test("collects record_offer events and exits on idle/end_turn", async () => {
    const events: ScriptedEvent[] = [
      {
        id: "sevt_1",
        type: "agent.custom_tool_use",
        name: "record_offer",
        input: {
          provider: "GoodRx",
          price_usd: 12,
          terms_url: "https://goodrx.com/atorvastatin",
          channel: "email",
          notes: "GoodRx coupon at the closest Walgreens.",
          recommended: true,
        },
        processed_at: "2026-04-25T00:00:00Z",
      },
      {
        id: "sevt_2",
        type: "agent.custom_tool_use",
        name: "record_offer",
        input: {
          provider: "Mark Cuban Cost Plus",
          price_usd: 6.5,
          terms_url: "https://costplusdrugs.com/medications/atorvastatin-20mg",
          channel: "email",
          notes: "Manufacturer cost + 15% markup, mail-order.",
          recommended: true,
        },
        processed_at: "2026-04-25T00:00:01Z",
      },
      {
        id: "sevt_3",
        type: "agent.custom_tool_use",
        name: "record_offer",
        input: {
          provider: "Local Indie Pharmacy",
          price_usd: 70,
          terms_url: "https://indiepharm.example.com/atorvastatin",
          recommended: false,
          notes: "Cash-pay discount, marginally cheaper.",
        },
        processed_at: "2026-04-25T00:00:02Z",
      },
      {
        id: "sevt_4",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-04-25T00:00:03Z",
      },
    ];
    const m = makeMockClient(events);

    const result = await runOfferHunt({ baseline, anthropic: m.client });

    expect(result.offers.length).toBe(3);
    expect(result.outcome).toBe("lower_price_found");
    expect(result.best?.provider).toBe("Mark Cuban Cost Plus");
    expect(result.best?.savings_vs_baseline).toBe(80 - 6.5);
    expect(result.total_monthly_savings).toBe(80 - 6.5);

    // Each record_offer should have triggered a user.custom_tool_result back.
    // The kickoff user.message is the first batch; tool results follow.
    const allSent = m.sentEventBatches.flat();
    const kickoffs = allSent.filter((e) => e.type === "user.message");
    const toolResults = allSent.filter((e) => e.type === "user.custom_tool_result");
    expect(kickoffs.length).toBe(1);
    expect(toolResults.length).toBe(3);
    expect(toolResults.map((r) => r.custom_tool_use_id)).toEqual([
      "sevt_1",
      "sevt_2",
      "sevt_3",
    ]);

    // Session must be archived even on the happy path.
    expect(m.archivedSessions).toEqual(["sesn_test_abc"]);
  });

  test("mark_exhausted with no offers yields exhausted_no_results", async () => {
    const events: ScriptedEvent[] = [
      {
        id: "sevt_1",
        type: "agent.custom_tool_use",
        name: "mark_exhausted",
        input: { category: "prescription", current_provider_lowest: true },
        processed_at: "2026-04-25T00:00:00Z",
      },
      {
        id: "sevt_2",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-04-25T00:00:01Z",
      },
    ];
    const m = makeMockClient(events);

    const result = await runOfferHunt({ baseline, anthropic: m.client });

    expect(result.offers.length).toBe(0);
    expect(result.outcome).toBe("exhausted_no_results");
    expect(result.best).toBeNull();
    expect(m.archivedSessions).toEqual(["sesn_test_abc"]);
  });

  test("offers without recommended=true mark current as lowest", async () => {
    const events: ScriptedEvent[] = [
      {
        id: "sevt_1",
        type: "agent.custom_tool_use",
        name: "record_offer",
        input: {
          provider: "Pricey Alternative",
          price_usd: 90, // worse than baseline
          terms_url: "https://example.com/pricey",
          recommended: false,
        },
        processed_at: "2026-04-25T00:00:00Z",
      },
      {
        id: "sevt_2",
        type: "agent.custom_tool_use",
        name: "mark_exhausted",
        input: { category: "prescription", current_provider_lowest: true },
        processed_at: "2026-04-25T00:00:01Z",
      },
      {
        id: "sevt_3",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-04-25T00:00:02Z",
      },
    ];
    const m = makeMockClient(events);

    const result = await runOfferHunt({ baseline, anthropic: m.client });

    expect(result.offers.length).toBe(1);
    expect(result.outcome).toBe("current_is_lowest");
    expect(result.best).toBeNull();
  });

  test("invalid record_offer input is rejected without crashing", async () => {
    const events: ScriptedEvent[] = [
      {
        id: "sevt_1",
        type: "agent.custom_tool_use",
        name: "record_offer",
        // missing terms_url + price
        input: { provider: "Bad Offer", recommended: true },
        processed_at: "2026-04-25T00:00:00Z",
      },
      {
        id: "sevt_2",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-04-25T00:00:01Z",
      },
    ];
    const m = makeMockClient(events);

    const result = await runOfferHunt({ baseline, anthropic: m.client });

    expect(result.offers.length).toBe(0);
    // The loop should still respond to the agent so it doesn't deadlock.
    const toolResults = m.sentEventBatches
      .flat()
      .filter((e) => e.type === "user.custom_tool_result");
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.custom_tool_use_id).toBe("sevt_1");
  });
});

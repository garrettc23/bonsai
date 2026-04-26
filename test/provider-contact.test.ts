/**
 * Provider-contact resolution tests.
 *
 * The resolver wraps anthropic.messages.create with a 30s AbortController
 * (env-overridable via BONSAI_CONTACT_LOOKUP_TIMEOUT_MS) so obscure
 * providers can't hang the negotiator. These tests cover:
 *
 *   - timeout path returns the documented shape and DOES NOT cache
 *   - happy path saves the cache row and returns the structured contact
 *   - low-confidence with no email/phone collapses to confidence:"none"
 *
 * Run: bun test test/provider-contact.test.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import {
  CONTACT_TIMEOUT_NOTE,
  resolveProviderContact,
} from "../src/lib/provider-contact.ts";

const TEST_DB_DIR = join(tmpdir(), `bonsai-provider-contact-test-${process.pid}-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, "bonsai.db");

function nukeOut(): void {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });
  _resetDbForTest();
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB_PATH;
  // Tiny timeout keeps the timeout test fast — the abort fires within
  // ~25ms instead of the production 30s.
  process.env.BONSAI_CONTACT_LOOKUP_TIMEOUT_MS = "25";
  nukeOut();
});

afterAll(() => {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  _resetDbForTest();
  delete process.env.BONSAI_DB_PATH;
  delete process.env.BONSAI_CONTACT_LOOKUP_TIMEOUT_MS;
});

beforeEach(() => {
  nukeOut();
});

afterEach(() => {
  nukeOut();
});

interface CreateOpts {
  signal?: AbortSignal;
}

/**
 * Mock Anthropic whose `messages.create` returns a promise that only
 * rejects when the caller's signal aborts. This is exactly how the SDK
 * surfaces an abort: it rejects with an AbortError-shaped error and the
 * caller's signal is then `.aborted === true`.
 */
function neverResolvingAnthropic(): { client: Anthropic; aborted: () => boolean } {
  let didAbort = false;
  const client = {
    messages: {
      create: (_body: unknown, opts?: CreateOpts) =>
        new Promise((_, reject) => {
          const onAbort = () => {
            didAbort = true;
            reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" }));
          };
          if (opts?.signal?.aborted) {
            onAbort();
            return;
          }
          opts?.signal?.addEventListener("abort", onAbort, { once: true });
        }),
    },
  } as unknown as Anthropic;
  return { client, aborted: () => didAbort };
}

interface ScriptedToolUse {
  name: string;
  input: Record<string, unknown>;
}

function scriptedAnthropic(toolUse: ScriptedToolUse | null): Anthropic {
  return {
    messages: {
      create: async () => ({
        stop_reason: toolUse ? "tool_use" : "end_turn",
        content: toolUse
          ? [{ type: "tool_use", id: "t1", name: toolUse.name, input: toolUse.input }]
          : [{ type: "text", text: "no tool call" }],
      }),
    },
  } as unknown as Anthropic;
}

function countCacheRows(cache_key: string): number {
  const row = getDb()
    .query("SELECT COUNT(*) as n FROM provider_contacts WHERE cache_key = ?")
    .get(cache_key) as { n: number } | null;
  return row?.n ?? 0;
}

describe("resolveProviderContact — timeout path", () => {
  test("returns confidence:'none' shape when the SDK call hangs past the timeout", async () => {
    const { client, aborted } = neverResolvingAnthropic();
    const result = await resolveProviderContact({
      provider_name: "Obscure Provider LLC",
      provider_address: "123 Nowhere Rd",
      anthropic: client,
    });
    expect(aborted()).toBe(true);
    expect(result.confidence).toBe("none");
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.source_urls).toEqual([]);
    expect(result.notes).toBe(CONTACT_TIMEOUT_NOTE);
    expect(result.cache_key).toBe("obscure provider llc||123 nowhere rd");
    expect(typeof result.resolved_at).toBe("number");
  });

  test("does NOT cache the timeout result — a transient hang must not poison future lookups", async () => {
    const { client } = neverResolvingAnthropic();
    const result = await resolveProviderContact({
      provider_name: "Hangs On Search",
      anthropic: client,
    });
    expect(result.confidence).toBe("none");
    expect(countCacheRows(result.cache_key)).toBe(0);
  });
});

describe("resolveProviderContact — happy path", () => {
  test("returns a structured contact and saves the cache row", async () => {
    const client = scriptedAnthropic({
      name: "report_provider_contact",
      input: {
        email: "billing@hospital.example",
        phone: "+1-415-555-0132",
        source_urls: ["https://hospital.example/billing"],
        confidence: "high",
        notes: "Found on hospital.example/billing — Patient Accounts page.",
      },
    });
    const result = await resolveProviderContact({
      provider_name: "Test Hospital",
      provider_address: null,
      anthropic: client,
    });
    expect(result.confidence).toBe("high");
    expect(result.email).toBe("billing@hospital.example");
    expect(result.phone).toBe("+1-415-555-0132");
    expect(result.source_urls).toEqual(["https://hospital.example/billing"]);
    expect(countCacheRows(result.cache_key)).toBe(1);
  });
});

describe("resolveProviderContact — low-confidence garbage", () => {
  test("low confidence with neither email nor phone collapses to 'none'", async () => {
    const client = scriptedAnthropic({
      name: "report_provider_contact",
      input: {
        email: null,
        phone: null,
        source_urls: [],
        confidence: "low",
        notes: "Couldn't find a credible source.",
      },
    });
    const result = await resolveProviderContact({
      provider_name: "Mystery Telecom",
      anthropic: client,
    });
    expect(result.confidence).toBe("none");
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.notes).toBe(CONTACT_TIMEOUT_NOTE);
  });

  test("model returning no tool block also collapses to 'none'", async () => {
    const client = scriptedAnthropic(null);
    const result = await resolveProviderContact({
      provider_name: "Won't Tool-Call Inc",
      anthropic: client,
    });
    expect(result.confidence).toBe("none");
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
  });
});

/**
 * Tests for persisted autonomy consent (Workstream A3, production) and the
 * ingestion idempotency ledger (A2). Both are SQLite-backed and read outside
 * any request context, so they're pinned against a throwaway DB.
 *
 * Run: bun test test/autonomy-consent-store.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest } from "../src/lib/db.ts";
import { createUser } from "../src/lib/auth.ts";
import { getConsent, setConsent } from "../src/lib/autonomy-consent-store.ts";
import { claimMessageForIngest } from "../src/server/ingest-email.ts";

const TEST_DB_DIR = join(tmpdir(), `bonsai-consent-${process.pid}-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, "bonsai.db");

function nuke(): void {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  _resetDbForTest();
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB_PATH;
  nuke();
});
afterAll(() => {
  nuke();
  delete process.env.BONSAI_DB_PATH;
});
beforeEach(nuke);
afterEach(nuke);

describe("consent persistence", () => {
  let uid: string;
  beforeEach(async () => {
    // Outer beforeEach already nuked the DB; create a real user (FK target).
    uid = (await createUser(`consent-${Date.now()}@example.com`, "password123", { acceptedTerms: true })).id;
  });

  test("a user with no row defaults to copilot (safe)", () => {
    const c = getConsent(uid);
    expect(c.mode).toBe("copilot");
    expect(c.auto_send_ceiling_usd).toBe(0);
    expect(c.allowed_categories).toEqual([]);
  });

  test("set then get round-trips a normalized policy", () => {
    const stored = setConsent(uid, {
      mode: "autonomous",
      auto_send_ceiling_usd: 150,
      allowed_categories: ["utility", "telecom"],
    });
    expect(stored.mode).toBe("autonomous");
    const loaded = getConsent(uid);
    expect(loaded).toEqual(stored);
    expect(loaded.allowed_categories).toEqual(["utility", "telecom"]);
  });

  test("upsert overwrites a prior policy", () => {
    setConsent(uid, { mode: "autonomous", auto_send_ceiling_usd: 50, allowed_categories: ["utility"] });
    setConsent(uid, { mode: "off", auto_send_ceiling_usd: 0, allowed_categories: [] });
    expect(getConsent(uid).mode).toBe("off");
  });

  test("sanitizes hostile input: bad mode → copilot, negative ceiling → 0, junk categories dropped", () => {
    const stored = setConsent(uid, {
      mode: "yolo" as never,
      auto_send_ceiling_usd: -999,
      allowed_categories: ["utility", "garbage", 42 as never] as never,
    });
    expect(stored.mode).toBe("copilot");
    expect(stored.auto_send_ceiling_usd).toBe(0);
    expect(stored.allowed_categories).toEqual(["utility"]);
  });

  test("de-dupes repeated categories", () => {
    const stored = setConsent(uid, {
      mode: "autonomous",
      auto_send_ceiling_usd: 10,
      allowed_categories: ["telecom", "telecom", "utility"],
    });
    expect(stored.allowed_categories).toEqual(["telecom", "utility"]);
  });
});

describe("ingestion idempotency ledger", () => {
  test("first claim wins, re-delivery of the same id is rejected", () => {
    expect(claimMessageForIngest("msg_abc", "usr_1")).toBe(true);
    expect(claimMessageForIngest("msg_abc", "usr_1")).toBe(false);
    expect(claimMessageForIngest("msg_abc")).toBe(false);
  });

  test("distinct ids are each processed once", () => {
    expect(claimMessageForIngest("msg_1")).toBe(true);
    expect(claimMessageForIngest("msg_2")).toBe(true);
  });

  test("a missing id is always processed (cannot dedup what we cannot key)", () => {
    expect(claimMessageForIngest(undefined)).toBe(true);
    expect(claimMessageForIngest(undefined)).toBe(true);
  });
});

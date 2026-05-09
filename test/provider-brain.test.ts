/**
 * Unit tests for the provider brain — the cross-user playbook store
 * that compounds context across negotiations of the same provider.
 *
 * Covered:
 *   - providerKey() slug normalization
 *   - hashUserId() requires the HMAC secret + is deterministic
 *   - piiViolation() catches dollar amounts, identifiers, emails, etc.
 *   - upsertBrain() is atomic, rejects on PII, respects opt-out
 *   - readBrain() / readRecentEvents() round-trip
 *
 * Each test runs against a throwaway SQLite under TMPDIR so it can't
 * touch the dev database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest } from "../src/lib/db.ts";
import {
  hashUserId,
  isOptedOut,
  piiViolation,
  providerKey,
  readBrain,
  readRecentEvents,
  upsertBrain,
} from "../src/brain/provider-brain.ts";

const TEST_DB_DIR = join(tmpdir(), `bonsai-brain-test-${process.pid}-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, "bonsai.db");

function nukeOut(): void {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  _resetDbForTest();
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB_PATH;
  process.env.BONSAI_BRAIN_HMAC_KEY = "test-hmac-secret-do-not-use-in-prod-fortyplus-chars";
  nukeOut();
});

afterAll(() => {
  nukeOut();
  delete process.env.BONSAI_DB_PATH;
  delete process.env.BONSAI_BRAIN_HMAC_KEY;
});

beforeEach(() => {
  nukeOut();
  delete process.env.BONSAI_BRAIN_OPT_OUT;
});

afterEach(() => {
  delete process.env.BONSAI_BRAIN_OPT_OUT;
});

describe("providerKey", () => {
  test("normalizes display name to a slug", () => {
    expect(providerKey("Aetna")).toBe("aetna");
    expect(providerKey("Aetna Inc.")).toBe("aetna");
    expect(providerKey("Aetna, Inc.")).toBe("aetna");
  });

  test("expands ampersands", () => {
    expect(providerKey("PG&E")).toBe("pg-and-e");
  });

  test("collapses non-alphanumeric runs", () => {
    expect(providerKey("Comcast / Xfinity")).toBe("comcast-xfinity");
  });

  test("returns 'unknown' for empty / non-alpha names", () => {
    expect(providerKey("")).toBe("unknown");
    expect(providerKey("---")).toBe("unknown");
  });

  test("caps slug length to keep keys reasonable", () => {
    const long = "A".repeat(120);
    expect(providerKey(long).length).toBeLessThanOrEqual(64);
  });
});

describe("hashUserId", () => {
  test("requires BONSAI_BRAIN_HMAC_KEY to be set", () => {
    const prior = process.env.BONSAI_BRAIN_HMAC_KEY;
    delete process.env.BONSAI_BRAIN_HMAC_KEY;
    try {
      expect(() => hashUserId("user-1")).toThrow(/BONSAI_BRAIN_HMAC_KEY/);
    } finally {
      process.env.BONSAI_BRAIN_HMAC_KEY = prior;
    }
  });

  test("is deterministic for the same input + key", () => {
    expect(hashUserId("user-1")).toBe(hashUserId("user-1"));
  });

  test("differs for different inputs", () => {
    expect(hashUserId("user-1")).not.toBe(hashUserId("user-2"));
  });

  test("differs across HMAC keys (deploy isolation)", () => {
    const a = hashUserId("user-1");
    process.env.BONSAI_BRAIN_HMAC_KEY = "different-secret-fortyplus-characters-required";
    const b = hashUserId("user-1");
    expect(a).not.toBe(b);
  });
});

describe("piiViolation", () => {
  test("flags dollar amounts", () => {
    expect(piiViolation("rep offered $450")).toBe("dollar_amount");
    expect(piiViolation("around $1,234.56")).toBe("dollar_amount");
    expect(piiViolation("about 900 dollars")).toBe("dollar_amount_word");
  });

  test("flags identifier patterns", () => {
    expect(piiViolation("disputed CLM-001")).toBe("identifier_pattern");
    expect(piiViolation("see ACCT-9876")).toBe("identifier_pattern");
    expect(piiViolation("policy POL12345 was applied")).toBe("identifier_pattern");
  });

  test("flags long bare digit runs", () => {
    expect(piiViolation("order 1234567 placed")).toBe("long_digit_run");
  });

  test("flags email addresses", () => {
    expect(piiViolation("contact jane.doe@hospital.com for details")).toBe("email_address");
  });

  test("passes pattern-level prose", () => {
    expect(piiViolation("rep typically opens with a 30-50% reduction")).toBeNull();
    expect(piiViolation("supervisors handle disputes faster than first-line reps")).toBeNull();
    expect(piiViolation("citing the EOB explicitly unlocked movement")).toBeNull();
  });
});

describe("isOptedOut", () => {
  test("respects BONSAI_BRAIN_OPT_OUT=1", () => {
    expect(isOptedOut()).toBe(false);
    process.env.BONSAI_BRAIN_OPT_OUT = "1";
    expect(isOptedOut()).toBe(true);
  });
});

describe("upsertBrain → readBrain round trip", () => {
  test("inserts a new provider page and counts events", () => {
    const page = upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth: "Rep typically opens with a 30-50% reduction without push-back.",
      events: [
        { kind: "first_offer_pattern", detail: "rep typically opens with a 30-50% reduction" },
        { kind: "concession_unlock", detail: "EOB citation unlocked movement" },
      ],
      thread_id: "thread_a",
      user_id: "user-1",
      now: 1_700_000_000_000,
    });
    expect(page).not.toBeNull();
    expect(page?.event_count).toBe(2);
    const read = readBrain("aetna");
    expect(read?.compiled_truth).toContain("30-50%");
    const events = readRecentEvents("aetna");
    expect(events.length).toBe(2);
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["first_offer_pattern", "concession_unlock"]),
    );
  });

  test("upsert on existing key sums event_count and overwrites compiled_truth", () => {
    upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth: "First impression playbook.",
      events: [{ kind: "first_offer_pattern", detail: "first round" }],
      thread_id: "thread_a",
      user_id: "user-1",
    });
    upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth: "Updated playbook with more nuance.",
      events: [
        { kind: "objection_pattern", detail: "rep demanded itemized re-billing" },
        { kind: "outcome_pattern", detail: "closed in two rounds" },
      ],
      thread_id: "thread_b",
      user_id: "user-2",
    });
    const page = readBrain("aetna");
    expect(page?.compiled_truth).toBe("Updated playbook with more nuance.");
    expect(page?.event_count).toBe(3);
    const events = readRecentEvents("aetna");
    expect(events.length).toBe(3);
  });

  test("rejects the entire batch when an event detail contains PII", () => {
    const result = upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth: "Clean compiled truth at the pattern level.",
      events: [
        { kind: "first_offer_pattern", detail: "rep opens with a meaningful reduction" },
        { kind: "outcome_pattern", detail: "rep offered $450 — leak" }, // PII
      ],
      thread_id: "thread_a",
      user_id: "user-1",
    });
    expect(result).toBeNull();
    expect(readBrain("aetna")).toBeNull();
    expect(readRecentEvents("aetna")).toEqual([]);
  });

  test("rejects when compiled_truth itself contains PII", () => {
    const result = upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth: "Aetna's first offer is usually $450 — leak.",
      events: [{ kind: "first_offer_pattern", detail: "clean event detail" }],
      thread_id: "thread_a",
      user_id: "user-1",
    });
    expect(result).toBeNull();
    expect(readBrain("aetna")).toBeNull();
  });

  test("opt-out makes the upsert a no-op", () => {
    process.env.BONSAI_BRAIN_OPT_OUT = "1";
    const result = upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth: "Pattern-level summary.",
      events: [{ kind: "first_offer_pattern", detail: "rep opens with a meaningful reduction" }],
      thread_id: "thread_a",
      user_id: "user-1",
    });
    expect(result).toBeNull();
    expect(readBrain("aetna")).toBeNull();
  });

  test("HMAC user_id_hash differs across users for the same provider", () => {
    upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth: "Pattern-level summary.",
      events: [{ kind: "first_offer_pattern", detail: "user-1 thread" }],
      thread_id: "thread_a",
      user_id: "user-1",
    });
    upsertBrain({
      provider_key: "aetna",
      display_name: "Aetna",
      bill_kind: "medical",
      compiled_truth: "Pattern-level summary.",
      events: [{ kind: "first_offer_pattern", detail: "user-2 thread" }],
      thread_id: "thread_b",
      user_id: "user-2",
    });
    // Both events present, distinct user_id_hash values — query
    // through the raw row shape since readRecentEvents() drops it.
    const { getDb } = require("../src/lib/db.ts");
    const rows = getDb()
      .query("SELECT user_id_hash FROM provider_brain_events WHERE provider_key = ?")
      .all("aetna") as Array<{ user_id_hash: string }>;
    const hashes = new Set(rows.map((r) => r.user_id_hash));
    expect(hashes.size).toBe(2);
  });
});

/**
 * Rate-limit module tests.
 *
 * Pure unit tests on src/lib/rate-limit.ts — no HTTP, no server boot.
 * Time is controlled via spying on Date.now so window-expiry cases run
 * instantly instead of sleeping.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  _resetRateLimitForTest,
  getClientIp,
  rateLimit,
  rateLimitResponse,
} from "../src/lib/rate-limit.ts";

let nowMs = 1_700_000_000_000;
let dateSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  _resetRateLimitForTest();
  nowMs = 1_700_000_000_000;
  dateSpy = spyOn(Date, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  dateSpy?.mockRestore();
  dateSpy = null;
  _resetRateLimitForTest();
});

describe("rateLimit", () => {
  test("allows up to max requests inside the window", () => {
    for (let i = 0; i < 5; i++) {
      const r = rateLimit({ key: "k", max: 5, windowMs: 60_000 });
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(5 - (i + 1));
    }
  });

  test("rejects the (max+1)th request with non-zero retryAfterSec", () => {
    for (let i = 0; i < 3; i++) {
      const r = rateLimit({ key: "k", max: 3, windowMs: 60_000 });
      expect(r.ok).toBe(true);
    }
    const r = rateLimit({ key: "k", max: 3, windowMs: 60_000 });
    expect(r.ok).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect(r.retryAfterSec).toBeLessThanOrEqual(60);
  });

  test("the oldest slot frees up after windowMs elapses", () => {
    for (let i = 0; i < 3; i++) {
      const r = rateLimit({ key: "k", max: 3, windowMs: 60_000 });
      expect(r.ok).toBe(true);
      nowMs += 1_000; // 3 hits at t=0,1,2 seconds
    }
    // Still inside the window — should reject.
    const blocked = rateLimit({ key: "k", max: 3, windowMs: 60_000 });
    expect(blocked.ok).toBe(false);

    // Advance past the window relative to the first hit. The first hit was at
    // t=1_700_000_000_000, the blocked attempt is at t=+3s, so jumping +60s
    // past the first hit (now = first + 60_001 ms) drops the first slot.
    nowMs = 1_700_000_000_000 + 60_001;
    const allowed = rateLimit({ key: "k", max: 3, windowMs: 60_000 });
    expect(allowed.ok).toBe(true);
  });

  test("distinct keys are independent", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit({ key: "a", max: 5, windowMs: 60_000 }).ok).toBe(true);
    }
    expect(rateLimit({ key: "a", max: 5, windowMs: 60_000 }).ok).toBe(false);
    // 'b' has its own counter.
    expect(rateLimit({ key: "b", max: 5, windowMs: 60_000 }).ok).toBe(true);
  });

  test("rejected calls do not consume the slot", () => {
    // 5 hits fill the bucket.
    for (let i = 0; i < 5; i++) {
      rateLimit({ key: "k", max: 5, windowMs: 60_000 });
    }
    // Repeated rejected calls don't push timestamps; once the window clears,
    // we get exactly `max` allowances back, not more.
    for (let i = 0; i < 10; i++) {
      const r = rateLimit({ key: "k", max: 5, windowMs: 60_000 });
      expect(r.ok).toBe(false);
    }
    nowMs += 60_001;
    for (let i = 0; i < 5; i++) {
      expect(rateLimit({ key: "k", max: 5, windowMs: 60_000 }).ok).toBe(true);
    }
    expect(rateLimit({ key: "k", max: 5, windowMs: 60_000 }).ok).toBe(false);
  });

  test("_resetRateLimitForTest clears state", () => {
    for (let i = 0; i < 5; i++) {
      rateLimit({ key: "k", max: 5, windowMs: 60_000 });
    }
    expect(rateLimit({ key: "k", max: 5, windowMs: 60_000 }).ok).toBe(false);
    _resetRateLimitForTest();
    expect(rateLimit({ key: "k", max: 5, windowMs: 60_000 }).ok).toBe(true);
  });
});

describe("rateLimitResponse", () => {
  test("returns 429 with Retry-After header and JSON body", async () => {
    const res = rateLimitResponse(42, "slow down");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    const body = (await res.json()) as { error: string; retry_after_sec: number };
    expect(body.error).toBe("slow down");
    expect(body.retry_after_sec).toBe(42);
  });

  test("Retry-After is at least 1 even when retryAfterSec is 0", () => {
    const res = rateLimitResponse(0, "edge case");
    expect(res.headers.get("Retry-After")).toBe("1");
  });
});

describe("getClientIp", () => {
  function reqWith(headers: Record<string, string>): Request {
    return new Request("https://example.test/x", { headers });
  }

  test("prefers the first entry in x-forwarded-for", () => {
    const req = reqWith({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  test("trims whitespace and lowercases", () => {
    const req = reqWith({ "x-forwarded-for": "  2001:DB8::1  " });
    expect(getClientIp(req)).toBe("2001:db8::1");
  });

  test("falls back to server.requestIP when xff is missing", () => {
    const req = reqWith({});
    const fakeServer = {
      requestIP: () => ({ address: "198.51.100.7" }),
    };
    expect(getClientIp(req, fakeServer)).toBe("198.51.100.7");
  });

  test("returns 'unknown' when no source resolves an IP", () => {
    const req = reqWith({});
    expect(getClientIp(req)).toBe("unknown");
    expect(getClientIp(req, { requestIP: () => null })).toBe("unknown");
  });
});

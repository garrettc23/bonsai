/**
 * In-memory sliding-window rate limiter.
 *
 * Per-key timestamp arrays, filtered against `now - windowMs` on every call.
 * Designed for single-host beta — no Redis dep, no cross-instance coherence.
 * When we go multi-host, swap the store; the call sites won't change.
 *
 * Keys are arbitrary strings; pick a namespace prefix per use site (e.g.
 * `signup:ip:1.2.3.4`, `forgot:alice@example.com`, `audit:user:usr_xxx`).
 */

const store = new Map<string, number[]>();

export interface RateLimitOptions {
  key: string;
  max: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the next slot opens. 0 when ok. */
  retryAfterSec: number;
  /** Slots remaining after this call (0 when rejected). */
  remaining: number;
}

export function rateLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const cutoff = now - opts.windowMs;
  const existing = store.get(opts.key) ?? [];
  // Drop expired timestamps. Array stays sorted ascending because we only push.
  let firstFresh = 0;
  while (firstFresh < existing.length && existing[firstFresh] <= cutoff) firstFresh++;
  const fresh = firstFresh === 0 ? existing : existing.slice(firstFresh);

  if (fresh.length >= opts.max) {
    const oldest = fresh[0];
    const retryAfterMs = Math.max(1, oldest + opts.windowMs - now);
    store.set(opts.key, fresh);
    return {
      ok: false,
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
      remaining: 0,
    };
  }

  fresh.push(now);
  store.set(opts.key, fresh);
  return {
    ok: true,
    retryAfterSec: 0,
    remaining: opts.max - fresh.length,
  };
}

export function rateLimitResponse(retryAfterSec: number, message: string): Response {
  return Response.json(
    { error: message, retry_after_sec: retryAfterSec },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfterSec)) },
    },
  );
}

interface ServerIpProvider {
  requestIP(req: Request): { address: string } | null;
}

export function getClientIp(req: Request, server?: ServerIpProvider): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.toLowerCase();
  }
  const direct = server?.requestIP(req)?.address;
  if (direct) return direct.toLowerCase();
  return "unknown";
}

export function _resetRateLimitForTest(): void {
  store.clear();
}

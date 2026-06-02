/**
 * Autonomy scheduler (Workstream A1).
 *
 * The audit's #1 gap: Bonsai only advanced a negotiation when a user opened
 * the SPA (maybeAdvancePersistentForUser is wired into the /api/history GET).
 * "Saves money while you sleep" needs a clock that sweeps EVERY user's
 * persistent-mode threads on its own, with no human in the loop.
 *
 * This is that clock. It reuses the existing per-thread advance logic
 * (advancePersistentNegotiation already persists an escalation gate before
 * dialing, so it's idempotent and safe to fire from both the SPA poll and
 * this scheduler at once).
 *
 * SAFE BY DEFAULT: disabled unless BONSAI_AUTONOMY=1. Acting on a customer's
 * bill with no human watching is consequential — autonomy is opt-in, and the
 * consent boundary in lib/autonomy-consent.ts governs what may actually send
 * without approval once it's on.
 */
import { listAllUsers, type User } from "../lib/auth.ts";
import { maybeAdvancePersistentForUser } from "./persistent-advance.ts";

const DEFAULT_INTERVAL_MIN = 15;

export function autonomyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BONSAI_AUTONOMY === "1";
}

export function autonomyIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.BONSAI_AUTONOMY_INTERVAL_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MIN;
  return min * 60 * 1000;
}

/**
 * One sweep across all users. Per-user failures are isolated and counted —
 * one account's bad state never stalls the rest. Returns counts for logging
 * and tests.
 *
 * `users` / `advance` are test seams; production uses the real DB + advance.
 */
export async function runAutonomyTick(opts?: {
  users?: User[];
  advance?: (user: User) => Promise<void>;
}): Promise<{ users: number; errors: number }> {
  const users = opts?.users ?? listAllUsers();
  const advance = opts?.advance ?? maybeAdvancePersistentForUser;
  let errors = 0;
  for (const user of users) {
    try {
      await advance(user);
    } catch (err) {
      errors += 1;
      console.error(`[autonomy] advance failed for user ${user.id}:`, (err as Error).message);
    }
  }
  return { users: users.length, errors };
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Start the scheduler. No-op (logs why) when autonomy is disabled. Fires one
 * tick on boot, then every autonomyIntervalMs. A tick failure never crashes
 * the process — runAutonomyTick swallows per-user errors and we catch the
 * rest here. Returns true if started.
 *
 * NOTE ON CONSENT: this loop only ADVANCES negotiations the user already
 * approved (persistent-mode email→voice escalation). The user consented to
 * that escalation when they approved persistent mode, so there is no new
 * autonomy decision here — the consent boundary (autonomy-consent.ts) governs
 * NEW autonomous actions (ingestion auto-send), not the continuation of
 * approved ones. Keep it that way: don't start un-approved sends from here.
 *
 * Overlap guard: if a sweep is still running when the interval fires again
 * (a large user table + slow advances), we skip rather than stack ticks.
 */
export function startAutonomyScheduler(): boolean {
  if (!autonomyEnabled()) {
    console.log("[autonomy] disabled (set BONSAI_AUTONOMY=1 to sweep persistent negotiations on a clock)");
    return false;
  }
  if (timer) return true; // already running
  const intervalMs = autonomyIntervalMs();
  const fire = () => {
    if (tickInFlight) {
      console.warn("[autonomy] previous tick still running — skipping this interval");
      return;
    }
    tickInFlight = true;
    runAutonomyTick()
      .then(({ users, errors }) =>
        console.log(`[autonomy] tick swept ${users} user(s)${errors ? `, ${errors} error(s)` : ""}`),
      )
      .catch((err) => console.error("[autonomy] tick FAILED", err))
      .finally(() => {
        tickInFlight = false;
      });
  };
  console.log(`[autonomy] enabled — sweeping every ${intervalMs / 60000} min`);
  fire();
  timer = setInterval(fire, intervalMs);
  return true;
}

/** Test seam: stop the interval so tests don't leak timers. */
export function stopAutonomyScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Per-user filesystem layout. Every user gets an isolated subtree under
 * `out/users/<user_id>/` so two users can't see each other's bills,
 * settings, transcripts, or uploads.
 *
 * Use `userPaths(userId)` for explicit calls (background workers,
 * migration scripts) and `currentUserPaths()` inside request-scoped code
 * — that one reads the user out of AsyncLocalStorage, so handlers don't
 * have to thread `userId` through every call.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentUser } from "./user-context.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

/**
 * Where Bonsai stores per-user data + the SQLite file. Locally that's
 * `<repo>/out`. On Railway / any container with a mounted volume, set
 * `BONSAI_DATA_DIR` to the volume mount path (e.g. `/app/data`) so all
 * stateful writes survive deploys / restarts. Trim whitespace so a
 * stray copy/paste with a trailing space doesn't strand the data.
 */
export function dataRoot(): string {
  const env = process.env.BONSAI_DATA_DIR?.trim();
  return env && env.length > 0 ? env : join(ROOT, "out");
}

export interface UserPaths {
  userId: string;
  /** Base directory: out/users/<id> */
  baseDir: string;
  /** Pending audit + negotiation runs awaiting completion. */
  pendingDir: string;
  /** Per-thread email transcripts + negotiation state. */
  threadsDir: string;
  /** Offer-hunt persisted runs. */
  offersDir: string;
  /** Voice-call simulator transcripts + state. */
  callsDir: string;
  /** Original user-uploaded bill files (PDFs, images, normalized JPEGs). */
  uploadsDir: string;
  /** This user's tune/profile/integrations JSON. */
  settingsPath: string;
  /** Final reports keyed by fixture/safe name. */
  reportPath: (safeName: string) => string;
  /** Final appeal markdown keyed by fixture/safe name. */
  appealPath: (safeName: string) => string;
  /** Iterate every report-*.json saved for this user. */
  reportsDir: string;
}

function safeUserId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Unsafe user id: ${id}`);
  return id;
}

export function userPaths(userId: string): UserPaths {
  const safe = safeUserId(userId);
  const baseDir = join(dataRoot(), "users", safe);
  const reportsDir = baseDir; // reports live at top level: report-<name>.json
  return {
    userId: safe,
    baseDir,
    pendingDir: join(baseDir, "pending"),
    threadsDir: join(baseDir, "threads"),
    offersDir: join(baseDir, "offers"),
    callsDir: join(baseDir, "calls"),
    uploadsDir: join(baseDir, "uploads"),
    settingsPath: join(baseDir, "user-settings.json"),
    reportPath: (n) => join(reportsDir, `report-${n}.json`),
    appealPath: (n) => join(reportsDir, `appeal-${n}.md`),
    reportsDir,
  };
}

/**
 * Resolve the active user's paths from the request-scoped context. Throws
 * if called outside of `withUserContext` — that's the signal a handler
 * forgot to wrap its work, which would otherwise silently leak data
 * across users.
 */
export function currentUserPaths(): UserPaths {
  const user = getCurrentUser();
  return userPaths(user.id);
}

/** Idempotent: ensure the user's tree exists on disk. Cheap to call repeatedly. */
export function ensureUserDirs(paths: UserPaths): void {
  for (const d of [paths.baseDir, paths.pendingDir, paths.threadsDir, paths.offersDir, paths.callsDir, paths.uploadsDir]) {
    mkdirSync(d, { recursive: true });
  }
}

/**
 * Auth + per-user path isolation tests.
 *
 * Covers the surface server.ts depends on: createUser, verifyCredentials,
 * getUserById, session lifecycle (create / get / delete / expiry), the
 * `requireUser` cookie-driven middleware, and the path resolver's
 * isolation guarantee — that two users never see each other's tree.
 *
 * Run: bun test test/auth.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthError,
  consumePasswordResetToken,
  createPasswordResetToken,
  createSession,
  createUser,
  deleteAllSessionsForUser,
  deleteSession,
  deleteUser,
  getPasswordResetToken,
  getSession,
  getUserByEmail,
  getUserById,
  readSessionCookie,
  requireUser,
  requireUserDiag,
  setSessionCookieHeader,
  verifyCredentials,
} from "../src/lib/auth.ts";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import { userPaths } from "../src/lib/user-paths.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname; // path resolution moved to TMPDIR — keep symbols imported.

// Run against a throwaway DB under TMPDIR so a parallel `bun run serve`
// keeps using the real `out/bonsai.db` and isn't disturbed by test runs.
const TEST_DB_DIR = join(tmpdir(), `bonsai-test-${process.pid}-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, "bonsai.db");

function nukeOut(): void {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  _resetDbForTest();
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB_PATH;
  nukeOut();
});

afterAll(() => {
  nukeOut();
  delete process.env.BONSAI_DB_PATH;
});

beforeEach(() => {
  // Each test gets a fresh DB — no cross-test bleed-through on email uniqueness.
  nukeOut();
});

afterEach(() => {
  nukeOut();
});

describe("createUser + verifyCredentials", () => {
  test("creates a user and verifies the password", async () => {
    const u = await createUser("alice@example.com", "supersecret", { acceptedTerms: true });
    expect(u.email).toBe("alice@example.com");
    expect(u.id).toMatch(/^usr_/);
    const verified = await verifyCredentials("alice@example.com", "supersecret");
    expect(verified.id).toBe(u.id);
  });

  test("normalizes email to lowercase + trim", async () => {
    const u = await createUser("  Alice@EXAMPLE.com  ", "supersecret", { acceptedTerms: true });
    expect(u.email).toBe("alice@example.com");
    const verified = await verifyCredentials("ALICE@example.com", "supersecret");
    expect(verified.id).toBe(u.id);
  });

  test("rejects invalid email shapes", async () => {
    await expect(createUser("not-an-email", "supersecret", { acceptedTerms: true })).rejects.toBeInstanceOf(AuthError);
    await expect(createUser("", "supersecret", { acceptedTerms: true })).rejects.toBeInstanceOf(AuthError);
  });

  test("rejects passwords shorter than 8 characters", async () => {
    await expect(createUser("a@b.com", "short", { acceptedTerms: true })).rejects.toMatchObject({ code: "weak_password" });
  });

  test("blocks duplicate emails", async () => {
    await createUser("dup@b.com", "supersecret", { acceptedTerms: true });
    await expect(createUser("dup@b.com", "different8", { acceptedTerms: true })).rejects.toMatchObject({ code: "email_taken" });
    // Case-insensitive uniqueness — DUP is the same account.
    await expect(createUser("DUP@b.com", "different8", { acceptedTerms: true })).rejects.toMatchObject({ code: "email_taken" });
  });

  test("verifyCredentials throws on wrong password", async () => {
    await createUser("bob@example.com", "supersecret", { acceptedTerms: true });
    await expect(verifyCredentials("bob@example.com", "wrongpass")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("verifyCredentials throws on unknown email (constant-time path)", async () => {
    await expect(verifyCredentials("ghost@example.com", "anything8")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("getUserById returns the row by id, null when missing", async () => {
    const u = await createUser("c@d.com", "supersecret", { acceptedTerms: true });
    expect(getUserById(u.id)?.email).toBe("c@d.com");
    expect(getUserById("usr_nope")).toBeNull();
  });

  test("password hash is not the plaintext password", async () => {
    await createUser("hash@d.com", "supersecret", { acceptedTerms: true });
    const row = getDb()
      .query("SELECT password_hash FROM users WHERE email = ?")
      .get("hash@d.com") as { password_hash: string } | null;
    expect(row?.password_hash).toBeTruthy();
    expect(row?.password_hash).not.toContain("supersecret");
    expect(row?.password_hash?.startsWith("$argon2")).toBe(true);
  });
});

describe("session lifecycle", () => {
  test("createSession + getSession round trip", async () => {
    const u = await createUser("s@d.com", "supersecret", { acceptedTerms: true });
    const sess = createSession(u.id);
    expect(sess.id).toMatch(/^[0-9a-f]+$/);
    expect(sess.user_id).toBe(u.id);
    const fetched = getSession(sess.id);
    expect(fetched?.user_id).toBe(u.id);
  });

  test("getSession returns null on unknown token", () => {
    expect(getSession("nope")).toBeNull();
  });

  test("expired sessions are evicted on get", async () => {
    const u = await createUser("e@d.com", "supersecret", { acceptedTerms: true });
    const sess = createSession(u.id);
    // Hand-edit expiry into the past.
    getDb().query("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1, sess.id);
    expect(getSession(sess.id)).toBeNull();
    // The expired row got cleaned out as a side effect.
    const row = getDb().query("SELECT id FROM sessions WHERE id = ?").get(sess.id);
    expect(row).toBeNull();
  });

  test("deleteSession removes the row", async () => {
    const u = await createUser("d@d.com", "supersecret", { acceptedTerms: true });
    const sess = createSession(u.id);
    deleteSession(sess.id);
    expect(getSession(sess.id)).toBeNull();
  });

  test("deleteAllSessionsForUser nukes every session for that user", async () => {
    const u = await createUser("multi@d.com", "supersecret", { acceptedTerms: true });
    const a = createSession(u.id);
    const b = createSession(u.id);
    deleteAllSessionsForUser(u.id);
    expect(getSession(a.id)).toBeNull();
    expect(getSession(b.id)).toBeNull();
  });

  test("deleteUser cascades to sessions", async () => {
    const u = await createUser("cas@d.com", "supersecret", { acceptedTerms: true });
    const sess = createSession(u.id);
    deleteUser(u.id);
    expect(getSession(sess.id)).toBeNull();
    expect(getUserById(u.id)).toBeNull();
  });
});

describe("requireUser middleware (cookie-driven)", () => {
  test("returns the user for a request carrying a valid session cookie", async () => {
    const u = await createUser("cookie@d.com", "supersecret", { acceptedTerms: true });
    const sess = createSession(u.id);
    const req = new Request("https://x.test/api/anything", {
      headers: { cookie: `bonsai_session=${sess.id}; some_other=foo` },
    });
    const got = requireUser(req);
    expect(got?.id).toBe(u.id);
    expect(got?.email).toBe("cookie@d.com");
  });

  test("returns null when there's no cookie at all", () => {
    const req = new Request("https://x.test/api/anything");
    expect(requireUser(req)).toBeNull();
  });

  test("returns null when the cookie names some other key", () => {
    const req = new Request("https://x.test/api/anything", {
      headers: { cookie: "session=foo; other=bar" },
    });
    expect(requireUser(req)).toBeNull();
  });

  test("returns null when the session token is bogus", () => {
    const req = new Request("https://x.test/api/anything", {
      headers: { cookie: "bonsai_session=not-a-real-token" },
    });
    expect(requireUser(req)).toBeNull();
  });

  test("readSessionCookie pulls the right value when multiple cookies are present", () => {
    const req = new Request("https://x.test/", {
      headers: { cookie: "a=1; bonsai_session=zzz; b=2" },
    });
    expect(readSessionCookie(req)).toBe("zzz");
  });

  test("setSessionCookieHeader produces an HTTP-only Set-Cookie header", () => {
    const header = setSessionCookieHeader("abc123");
    expect(header).toContain("bonsai_session=abc123");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toMatch(/Max-Age=\d+/);
  });
});

describe("requireUserDiag", () => {
  test("returns { user } when the cookie is valid", async () => {
    const u = await createUser("diag-ok@d.com", "supersecret", { acceptedTerms: true });
    const sess = createSession(u.id);
    const req = new Request("https://x.test/api/anything", {
      headers: { cookie: `bonsai_session=${sess.id}` },
    });
    const got = requireUserDiag(req);
    expect("user" in got).toBe(true);
    if ("user" in got) {
      expect(got.user.id).toBe(u.id);
      expect(got.user.email).toBe("diag-ok@d.com");
    }
  });

  test("returns { reason: 'no_cookie' } when no cookie header is present", () => {
    const req = new Request("https://x.test/api/anything");
    const got = requireUserDiag(req);
    expect(got).toEqual({ reason: "no_cookie" });
  });

  test("returns { reason: 'session_not_found' } when the session token is bogus", () => {
    const req = new Request("https://x.test/api/anything", {
      headers: { cookie: "bonsai_session=not-a-real-token" },
    });
    const got = requireUserDiag(req);
    expect(got).toEqual({ reason: "session_not_found" });
  });

  test("returns { reason: 'user_not_found' } when the session points at a missing user", async () => {
    const u = await createUser("diag-orphan@d.com", "supersecret", { acceptedTerms: true });
    const sess = createSession(u.id);
    // FK + cascade-delete makes it impossible to leave a real orphan in
    // the wild. Drop FKs for this one statement to synthesize the shape
    // requireUserDiag has to handle if a row ever did survive cleanup.
    const db = getDb();
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.query("UPDATE sessions SET user_id = ? WHERE id = ?").run("usr_nonexistent", sess.id);
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    const req = new Request("https://x.test/api/anything", {
      headers: { cookie: `bonsai_session=${sess.id}` },
    });
    const got = requireUserDiag(req);
    expect(got).toEqual({ reason: "user_not_found" });
  });
});

describe("password reset flow", () => {
  test("getUserByEmail returns the user (case-insensitive)", async () => {
    const u = await createUser("Reset@Example.com", "supersecret", { acceptedTerms: true });
    expect(getUserByEmail("reset@example.com")?.id).toBe(u.id);
    expect(getUserByEmail("RESET@example.com")?.id).toBe(u.id);
  });

  test("getUserByEmail returns null for unknown addresses", () => {
    expect(getUserByEmail("ghost@example.com")).toBeNull();
  });

  test("createPasswordResetToken issues a one-hour single-use token", async () => {
    const u = await createUser("r@x.com", "supersecret", { acceptedTerms: true });
    const t = createPasswordResetToken(u.id);
    expect(t.token).toMatch(/^[0-9a-f]+$/);
    expect(t.user_id).toBe(u.id);
    expect(t.expires_at - t.created_at).toBe(60 * 60 * 1000);
    expect(t.consumed_at).toBeNull();
    const fetched = getPasswordResetToken(t.token);
    expect(fetched?.user_id).toBe(u.id);
  });

  test("consumePasswordResetToken sets a new password and clears all sessions", async () => {
    const u = await createUser("c@x.com", "originalpass", { acceptedTerms: true });
    // Stash a session — it should disappear after reset.
    const oldSess = createSession(u.id);
    const t = createPasswordResetToken(u.id);
    await consumePasswordResetToken(t.token, "newpassword");
    // Old password no longer works.
    await expect(verifyCredentials("c@x.com", "originalpass")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    // New password works.
    const verified = await verifyCredentials("c@x.com", "newpassword");
    expect(verified.id).toBe(u.id);
    // Old sessions are gone.
    expect(getSession(oldSess.id)).toBeNull();
  });

  test("token can only be consumed once", async () => {
    const u = await createUser("o@x.com", "originalpass", { acceptedTerms: true });
    const t = createPasswordResetToken(u.id);
    await consumePasswordResetToken(t.token, "newpassword");
    await expect(consumePasswordResetToken(t.token, "anotherone")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("expired token is rejected", async () => {
    const u = await createUser("e@x.com", "originalpass", { acceptedTerms: true });
    const t = createPasswordResetToken(u.id);
    // Hand-edit expiry into the past — same trick as session-expiry test.
    const { getDb } = await import("../src/lib/db.ts");
    getDb().query("UPDATE password_resets SET expires_at = ? WHERE token = ?").run(Date.now() - 1, t.token);
    expect(getPasswordResetToken(t.token)).toBeNull();
    await expect(consumePasswordResetToken(t.token, "newpassword")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("reset rejects passwords shorter than 8 chars", async () => {
    const u = await createUser("w@x.com", "originalpass", { acceptedTerms: true });
    const t = createPasswordResetToken(u.id);
    await expect(consumePasswordResetToken(t.token, "short")).rejects.toMatchObject({
      code: "weak_password",
    });
    // Token is still valid because the password was rejected before consumption.
    const verified = await verifyCredentials("w@x.com", "originalpass");
    expect(verified.id).toBe(u.id);
  });

  test("garbage tokens are rejected", async () => {
    await expect(consumePasswordResetToken("definitely-not-a-token", "newpassword")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("deleting a user cascades to their reset tokens", async () => {
    const u = await createUser("d@x.com", "originalpass", { acceptedTerms: true });
    const t = createPasswordResetToken(u.id);
    deleteUser(u.id);
    expect(getPasswordResetToken(t.token)).toBeNull();
  });
});

describe("per-user path isolation", () => {
  test("two different user ids resolve to disjoint subtrees", () => {
    const a = userPaths("usr_aaaaaaaaaaaaaaaaaaaaaaaa");
    const b = userPaths("usr_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(a.baseDir).not.toBe(b.baseDir);
    expect(a.pendingDir.startsWith(a.baseDir)).toBe(true);
    expect(a.threadsDir.startsWith(a.baseDir)).toBe(true);
    expect(a.offersDir.startsWith(a.baseDir)).toBe(true);
    expect(a.callsDir.startsWith(a.baseDir)).toBe(true);
    expect(a.uploadsDir.startsWith(a.baseDir)).toBe(true);
    expect(a.settingsPath.startsWith(a.baseDir)).toBe(true);
    // No path from user A overlaps user B's tree.
    expect(b.pendingDir.startsWith(a.baseDir)).toBe(false);
  });

  test("written files in user A's tree are invisible to user B's resolver", () => {
    const a = userPaths("usr_aaaaaaaaaaaaaaaaaaaaaaaa");
    const b = userPaths("usr_bbbbbbbbbbbbbbbbbbbbbbbb");
    try {
      mkdirSync(a.pendingDir, { recursive: true });
      writeFileSync(join(a.pendingDir, "test.json"), JSON.stringify({ v: 1 }));
      expect(existsSync(join(a.pendingDir, "test.json"))).toBe(true);
      expect(existsSync(join(b.pendingDir, "test.json"))).toBe(false);
    } finally {
      // Don't leave the synthetic user trees behind in the running server's
      // out/ — they're harmless but make `ls out/users` confusing.
      if (existsSync(a.baseDir)) rmSync(a.baseDir, { recursive: true, force: true });
      if (existsSync(b.baseDir)) rmSync(b.baseDir, { recursive: true, force: true });
    }
  });

  test("rejects ids with shell-unsafe characters (path traversal guard)", () => {
    expect(() => userPaths("../../etc")).toThrow(/Unsafe user id/);
    expect(() => userPaths("usr/with/slash")).toThrow(/Unsafe user id/);
    expect(() => userPaths("usr with space")).toThrow(/Unsafe user id/);
    expect(() => userPaths("")).toThrow(/Unsafe user id/);
  });

  test("reportPath / appealPath produce per-user paths", () => {
    const a = userPaths("usr_aaaaaaaaaaaaaaaaaaaaaaaa");
    const b = userPaths("usr_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(a.reportPath("bill-001")).toMatch(/users\/usr_a+\/report-bill-001\.json$/);
    expect(b.reportPath("bill-001")).toMatch(/users\/usr_b+\/report-bill-001\.json$/);
    expect(a.appealPath("bill-001")).not.toBe(b.appealPath("bill-001"));
  });
});

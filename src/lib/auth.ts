/**
 * Authentication primitives: user creation, password hashing (Bun's
 * argon2id wrapper), session lifecycle, and a `requireUser` middleware
 * that pulls the session cookie off a Request and returns the
 * authenticated user — or null when the request is unauthenticated /
 * the session expired.
 */
import { randomBytes } from "node:crypto";
import { getDb } from "./db.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE_NAME = "bonsai_session";

export interface User {
  id: string;
  email: string;
  created_at: number;
  email_verified_at: number | null;
  accepted_terms_at: number | null;
  pending_email: string | null;
  /** Timestamp when the user signed up for the Comparison early-access
   * waitlist. Null when they haven't joined yet. */
  early_access_at: number | null;
  /** Google's stable subject ID — set when the account is linked to a
   * Google identity. Null for password-only accounts. */
  google_sub: string | null;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthError extends Error {
  constructor(
    public code:
      | "email_taken"
      | "invalid_credentials"
      | "weak_password"
      | "invalid_email"
      | "terms_not_accepted"
      | "email_not_verified"
      | "verification_invalid"
      | "user_not_found",
    message: string,
  ) {
    super(message);
  }
}

function isValidEmail(email: string): boolean {
  // Permissive but rejects obvious garbage — server-side guardrail, not the
  // last line of defense (a typo'd email survives this; the user logs back in).
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

export async function createUser(
  email: string,
  password: string,
  opts: { acceptedTerms: boolean } = { acceptedTerms: false },
): Promise<User> {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw new AuthError("invalid_email", "That doesn't look like an email address.");
  }
  if (password.length < 8) {
    throw new AuthError("weak_password", "Password must be at least 8 characters.");
  }
  if (!opts.acceptedTerms) {
    throw new AuthError(
      "terms_not_accepted",
      "You must accept the Terms of Service and Privacy Policy to create an account.",
    );
  }
  const db = getDb();
  const existing = db.query("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (existing) {
    throw new AuthError("email_taken", "An account with that email already exists.");
  }
  const id = newId("usr");
  const password_hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const now = Date.now();
  db.query(
    `INSERT INTO users (id, email, password_hash, created_at, accepted_terms_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, normalizedEmail, password_hash, now, now);
  return {
    id,
    email: normalizedEmail,
    created_at: now,
    email_verified_at: null,
    accepted_terms_at: now,
    pending_email: null,
    early_access_at: null,
    google_sub: null,
  };
}

type UserRow = {
  id: string;
  email: string;
  created_at: number;
  email_verified_at: number | null;
  accepted_terms_at: number | null;
  pending_email: string | null;
  early_access_at: number | null;
  google_sub: string | null;
};

const USER_COLUMNS =
  "id, email, created_at, email_verified_at, accepted_terms_at, pending_email, early_access_at, google_sub";

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    created_at: row.created_at,
    email_verified_at: row.email_verified_at,
    accepted_terms_at: row.accepted_terms_at,
    pending_email: row.pending_email,
    early_access_at: row.early_access_at ?? null,
    google_sub: row.google_sub ?? null,
  };
}

/**
 * Mark the user as joined to the Comparison early-access waitlist.
 * Idempotent — re-calling on an already-signed-up user is a no-op
 * that returns the existing timestamp.
 */
export function joinEarlyAccess(userId: string): User {
  const db = getDb();
  const existing = db
    .query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(userId) as UserRow | null;
  if (!existing) throw new AuthError("user_not_found", "User no longer exists.");
  if (!existing.early_access_at) {
    db.query(`UPDATE users SET early_access_at = ? WHERE id = ?`)
      .run(Date.now(), userId);
  }
  const fresh = db
    .query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(userId) as UserRow;
  return rowToUser(fresh);
}

/**
 * Remove the user from the Comparison early-access waitlist. Idempotent
 * — re-calling on a user who isn't on the list is a no-op.
 */
export function leaveEarlyAccess(userId: string): User {
  const db = getDb();
  const existing = db
    .query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(userId) as UserRow | null;
  if (!existing) throw new AuthError("user_not_found", "User no longer exists.");
  if (existing.early_access_at) {
    db.query(`UPDATE users SET early_access_at = NULL WHERE id = ?`)
      .run(userId);
  }
  const fresh = db
    .query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(userId) as UserRow;
  return rowToUser(fresh);
}

export async function verifyCredentials(email: string, password: string): Promise<User> {
  const normalizedEmail = normalizeEmail(email);
  const db = getDb();
  const row = db
    .query(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`)
    .get(normalizedEmail) as (UserRow & { password_hash: string }) | null;
  if (!row) {
    // Constant-time-ish: still hash to avoid leaking which path failed via timing.
    await Bun.password.verify(password, "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").catch(() => false);
    throw new AuthError("invalid_credentials", "Email or password is incorrect.");
  }
  const ok = await Bun.password.verify(password, row.password_hash);
  if (!ok) throw new AuthError("invalid_credentials", "Email or password is incorrect.");
  return rowToUser(row);
}

export function getUserById(id: string): User | null {
  const db = getDb();
  const row = db
    .query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(id) as UserRow | null;
  return row ? rowToUser(row) : null;
}

export function deleteUser(id: string): void {
  const db = getDb();
  db.query("DELETE FROM users WHERE id = ?").run(id);
}

export function createSession(userId: string): Session {
  const db = getDb();
  const id = newSessionToken();
  const now = Date.now();
  const expires_at = now + SESSION_TTL_MS;
  db.query(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(id, userId, now, expires_at);
  return { id, user_id: userId, created_at: now, expires_at };
}

export function getSession(token: string): Session | null {
  const db = getDb();
  const row = db
    .query("SELECT id, user_id, created_at, expires_at FROM sessions WHERE id = ?")
    .get(token) as Session | null;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.query("DELETE FROM sessions WHERE id = ?").run(token);
    return null;
  }
  return row;
}

export function deleteSession(token: string): void {
  const db = getDb();
  db.query("DELETE FROM sessions WHERE id = ?").run(token);
}

export function deleteAllSessionsForUser(userId: string): void {
  const db = getDb();
  db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function readSessionCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return rest.join("=");
  }
  return null;
}

/**
 * `Secure` flag should only be set on HTTPS deploys — adding it to a
 * `http://localhost` cookie causes browsers to silently refuse to set it,
 * which manifests as "I logged in but the session didn't stick." We key
 * off NODE_ENV instead of sniffing the request because Railway / Fly /
 * any reverse proxy terminates TLS upstream — `req.url` looks like
 * http://internal even though the user's connection is https.
 */
function cookieSecureFlag(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

export function setSessionCookieHeader(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecureFlag()}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag()}`;
}

/**
 * Pull the session token off the cookie and return the matching user, or
 * null when the request is unauthenticated. Use in handlers that protect
 * data; the caller decides whether to 401 or branch.
 */
export function requireUser(req: Request): User | null {
  const token = readSessionCookie(req);
  if (!token) return null;
  const session = getSession(token);
  if (!session) return null;
  return getUserById(session.user_id);
}

export type RequireUserDiag =
  | { user: User }
  | { reason: "no_cookie" | "session_not_found" | "user_not_found" };

/**
 * Like `requireUser`, but discriminates between the three failure modes so
 * the caller can log why a request was rejected without re-implementing the
 * cookie/session/user chain. Never returns the cookie value or session token
 * — only the failure category.
 */
export function requireUserDiag(req: Request): RequireUserDiag {
  const token = readSessionCookie(req);
  if (!token) return { reason: "no_cookie" };
  const session = getSession(token);
  if (!session) return { reason: "session_not_found" };
  const user = getUserById(session.user_id);
  if (!user) return { reason: "user_not_found" };
  return { user };
}

// ─── Password reset ─────────────────────────────────────────────
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PasswordResetToken {
  token: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

/** Look up a user by email — null if no match. Caller decides whether to leak. */
export function getUserByEmail(email: string): User | null {
  const db = getDb();
  const row = db
    .query(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`)
    .get(normalizeEmail(email)) as UserRow | null;
  return row ? rowToUser(row) : null;
}

// ─── Google OAuth ───────────────────────────────────────────────

/** Look up a user by their Google subject ID. */
export function getUserByGoogleSub(sub: string): User | null {
  const db = getDb();
  const row = db
    .query(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = ?`)
    .get(sub) as UserRow | null;
  return row ? rowToUser(row) : null;
}

/**
 * Create a user that signed in with Google. We still satisfy the NOT NULL
 * password_hash constraint by storing an Argon2id hash of a high-entropy
 * random secret the user will never see — they cannot password-login until
 * they go through forgot-password and set one. Email is marked verified
 * because Google verified it; terms are auto-accepted because the OAuth
 * consent screen surfaces our links and the act of approving the consent
 * is the acceptance.
 */
export async function createGoogleUser(email: string, googleSub: string): Promise<User> {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw new AuthError("invalid_email", "Google returned an email Bonsai can't accept.");
  }
  const db = getDb();
  const existingByEmail = db.query("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (existingByEmail) {
    throw new AuthError("email_taken", "An account with that email already exists.");
  }
  const id = newId("usr");
  const password_hash = await Bun.password.hash(
    randomBytes(32).toString("hex"),
    { algorithm: "argon2id" },
  );
  const now = Date.now();
  db.query(
    `INSERT INTO users (id, email, password_hash, created_at, accepted_terms_at, email_verified_at, google_sub)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, normalizedEmail, password_hash, now, now, now, googleSub);
  return {
    id,
    email: normalizedEmail,
    created_at: now,
    email_verified_at: now,
    accepted_terms_at: now,
    pending_email: null,
    early_access_at: null,
    google_sub: googleSub,
  };
}

/**
 * Link a Google identity to an existing password account. Used when a user
 * who already signed up with email + password later uses "Sign in with
 * Google" against the same email. We trust Google's email-verification
 * here — if the addresses match and Google says the email is verified,
 * the human in front of Google's consent screen owns the inbox we'd
 * otherwise let them password-reset against.
 */
export function linkGoogleSub(userId: string, sub: string): User {
  const db = getDb();
  db.query("UPDATE users SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
    .run(sub, Date.now(), userId);
  const user = getUserById(userId);
  if (!user) throw new AuthError("user_not_found", "Account no longer exists.");
  return user;
}

/**
 * Mint a single-use password-reset token for the given user. Tokens live for
 * one hour. The caller is responsible for delivering the token to the user
 * (email, dev log, whatever). We don't email here — that's the route's job.
 */
export function createPasswordResetToken(userId: string): PasswordResetToken {
  const db = getDb();
  const token = newSessionToken();
  const now = Date.now();
  const expires_at = now + RESET_TTL_MS;
  db.query(
    "INSERT INTO password_resets (token, user_id, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, NULL)",
  ).run(token, userId, now, expires_at);
  return { token, user_id: userId, created_at: now, expires_at, consumed_at: null };
}

/**
 * Look up a reset token, returning it if it's still valid (not expired, not
 * consumed). Expired/consumed tokens get cleaned up so the table doesn't
 * accumulate stale rows.
 */
export function getPasswordResetToken(token: string): PasswordResetToken | null {
  const db = getDb();
  const row = db
    .query("SELECT token, user_id, created_at, expires_at, consumed_at FROM password_resets WHERE token = ?")
    .get(token) as PasswordResetToken | null;
  if (!row) return null;
  if (row.consumed_at !== null) return null;
  if (row.expires_at < Date.now()) {
    db.query("DELETE FROM password_resets WHERE token = ?").run(token);
    return null;
  }
  return row;
}

/**
 * Consume a reset token: set the user's new password, mark the token used,
 * invalidate every existing session for the account so old cookies stop
 * working. Returns the user on success, throws AuthError on failure.
 */
export async function consumePasswordResetToken(
  token: string,
  newPassword: string,
): Promise<User> {
  if (newPassword.length < 8) {
    throw new AuthError("weak_password", "Password must be at least 8 characters.");
  }
  const reset = getPasswordResetToken(token);
  if (!reset) {
    throw new AuthError("invalid_credentials", "This reset link is invalid or expired.");
  }
  const db = getDb();
  const password_hash = await Bun.password.hash(newPassword, { algorithm: "argon2id" });
  // Atomically update the password, mark the token consumed, and clear the
  // user's sessions so an attacker holding a stolen cookie can't sneak past.
  const tx = db.transaction(() => {
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(password_hash, reset.user_id);
    db.query("UPDATE password_resets SET consumed_at = ? WHERE token = ?").run(Date.now(), token);
    db.query("DELETE FROM sessions WHERE user_id = ?").run(reset.user_id);
  });
  tx();
  const user = getUserById(reset.user_id);
  if (!user) throw new AuthError("invalid_credentials", "Account no longer exists.");
  return user;
}

// ─── Email verification ─────────────────────────────────────────
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface EmailVerificationToken {
  token: string;
  user_id: string;
  /** Set when this token verifies an email *change* (vs initial signup). */
  new_email: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

/**
 * Mint a verification token. `newEmail` is set when this confirms an email
 * change (the user's row holds `pending_email`); for initial signup
 * verification, leave it null and we just mark the existing email verified.
 */
export function createEmailVerificationToken(
  userId: string,
  newEmail: string | null = null,
): EmailVerificationToken {
  const db = getDb();
  const token = newSessionToken();
  const now = Date.now();
  const expires_at = now + VERIFICATION_TTL_MS;
  db.query(
    `INSERT INTO email_verifications (token, user_id, new_email, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(token, userId, newEmail, now, expires_at);
  return { token, user_id: userId, new_email: newEmail, created_at: now, expires_at, consumed_at: null };
}

export function getEmailVerificationToken(token: string): EmailVerificationToken | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT token, user_id, new_email, created_at, expires_at, consumed_at
       FROM email_verifications WHERE token = ?`,
    )
    .get(token) as EmailVerificationToken | null;
  if (!row) return null;
  if (row.consumed_at !== null) return null;
  if (row.expires_at < Date.now()) {
    db.query("DELETE FROM email_verifications WHERE token = ?").run(token);
    return null;
  }
  return row;
}

/**
 * Consume a verification token. For signup tokens (`new_email === null`),
 * sets `email_verified_at = now`. For change-email tokens, swaps
 * `pending_email` into `email` and clears `pending_email`. Returns the
 * fresh user.
 */
export function consumeEmailVerificationToken(token: string): User {
  const verification = getEmailVerificationToken(token);
  if (!verification) {
    throw new AuthError("verification_invalid", "This verification link is invalid or expired.");
  }
  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    if (verification.new_email) {
      // Email-change confirmation. Move pending_email → email; mark verified.
      // The new email becomes the canonical address only at this point — so
      // the unique-email constraint is what protects us from collisions.
      db.query(
        `UPDATE users SET email = ?, pending_email = NULL, email_verified_at = ? WHERE id = ?`,
      ).run(verification.new_email, now, verification.user_id);
    } else {
      db.query(`UPDATE users SET email_verified_at = ? WHERE id = ?`).run(
        now,
        verification.user_id,
      );
    }
    db.query("UPDATE email_verifications SET consumed_at = ? WHERE token = ?").run(now, token);
  });
  tx();
  const user = getUserById(verification.user_id);
  if (!user) throw new AuthError("invalid_credentials", "Account no longer exists.");
  return user;
}

// ─── Account ops ─────────────────────────────────────────────────
/**
 * Change password. Verifies the current password, hashes the new one, and
 * clears every existing session — the caller is responsible for minting a
 * fresh session cookie for the still-active client.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<User> {
  if (newPassword.length < 8) {
    throw new AuthError("weak_password", "Password must be at least 8 characters.");
  }
  const db = getDb();
  const row = db
    .query(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE id = ?`)
    .get(userId) as (UserRow & { password_hash: string }) | null;
  if (!row) throw new AuthError("invalid_credentials", "Account not found.");
  const ok = await Bun.password.verify(currentPassword, row.password_hash);
  if (!ok) throw new AuthError("invalid_credentials", "Current password is incorrect.");
  const password_hash = await Bun.password.hash(newPassword, { algorithm: "argon2id" });
  const tx = db.transaction(() => {
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(password_hash, userId);
    db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  });
  tx();
  return rowToUser({ ...row, password_hash } as UserRow);
}

/**
 * Begin an email change. Verifies the password, stores `pending_email` on
 * the user row, and mints a verification token tied to the new address.
 * The new email only becomes canonical when the token is consumed (via
 * `consumeEmailVerificationToken`) — until then the old email keeps
 * working for login.
 */
export async function beginEmailChange(
  userId: string,
  password: string,
  newEmail: string,
): Promise<{ user: User; verification: EmailVerificationToken }> {
  const normalized = normalizeEmail(newEmail);
  if (!isValidEmail(normalized)) {
    throw new AuthError("invalid_email", "That doesn't look like an email address.");
  }
  const db = getDb();
  const row = db
    .query(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE id = ?`)
    .get(userId) as (UserRow & { password_hash: string }) | null;
  if (!row) throw new AuthError("invalid_credentials", "Account not found.");
  if (row.email === normalized) {
    throw new AuthError("invalid_email", "That's already your email address.");
  }
  const ok = await Bun.password.verify(password, row.password_hash);
  if (!ok) throw new AuthError("invalid_credentials", "Password is incorrect.");
  // Reject if some other account already owns the new address.
  const taken = db.query("SELECT id FROM users WHERE email = ?").get(normalized);
  if (taken) {
    throw new AuthError("email_taken", "An account with that email already exists.");
  }
  db.query("UPDATE users SET pending_email = ? WHERE id = ?").run(normalized, userId);
  const verification = createEmailVerificationToken(userId, normalized);
  const user = getUserById(userId);
  if (!user) throw new AuthError("invalid_credentials", "Account no longer exists.");
  return { user, verification };
}

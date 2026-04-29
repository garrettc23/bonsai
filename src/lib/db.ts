/**
 * SQLite handle for the small relational pieces: users, sessions, and the
 * provider-contact resolution cache. Bills, reports, transcripts, and
 * settings stay file-based per user (see user-paths.ts) — SQLite is only
 * here for the data that actually needs joins / uniqueness / indices.
 *
 * Path resolution: `BONSAI_DB_PATH` env var wins (used by tests so they
 * don't stomp the running server's DB). Otherwise `out/bonsai.db`.
 *
 * Stale-handle recovery: macOS SQLite raises SQLITE_IOERR_VNODE when the
 * underlying file gets unlinked (e.g. test suite wipes `out/`). We detect
 * a missing file at the top of `getDb()` and reopen — so a manual
 * `rm -rf out/` doesn't 500 every subsequent request.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot } from "./user-paths.ts";

function resolveDbPath(): string {
  const fromEnv = process.env.BONSAI_DB_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(dataRoot(), "bonsai.db");
}

let _db: Database | null = null;
let _dbPath: string | null = null;

export function getDb(): Database {
  const targetPath = resolveDbPath();
  // Reopen if the configured path changed (test sets BONSAI_DB_PATH after
  // the first call) or if the file was unlinked from under us.
  if (_db && (_dbPath !== targetPath || !existsSync(targetPath))) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
    _dbPath = null;
  }
  if (_db) return _db;
  mkdirSync(dirname(targetPath), { recursive: true });
  const db = new Database(targetPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      email_verified_at INTEGER,
      accepted_terms_at INTEGER,
      pending_email TEXT,
      google_sub TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx
      ON users(google_sub) WHERE google_sub IS NOT NULL;

    CREATE TABLE IF NOT EXISTS email_verifications (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- new_email is set when this token confirms an email *change* (vs an
      -- initial signup verification). On consumption we move pending_email
      -- → email and clear pending_email.
      new_email TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS email_verifications_user_id_idx ON email_verifications(user_id);
    CREATE INDEX IF NOT EXISTS email_verifications_expires_idx ON email_verifications(expires_at);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS provider_contacts (
      cache_key TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL,
      provider_address TEXT,
      email TEXT,
      phone TEXT,
      source_urls TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL DEFAULT 'low',
      notes TEXT,
      resolved_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS password_resets_user_id_idx ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS password_resets_expires_idx ON password_resets(expires_at);

    CREATE TABLE IF NOT EXISTS voice_agents (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      agent_config_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_spend (
      utc_date TEXT PRIMARY KEY,
      total_usd REAL NOT NULL
    );

    -- Cached Managed-Agents agent IDs. Keyed on purpose ("offer-hunt", future
    -- managed agents land alongside) so we create the cloud-hosted agent +
    -- environment once and reuse them across runs. agent_config_hash is a
    -- SHA-256 of the canonical config — when we tweak the system prompt or
    -- tool schema we want a fresh agent so existing in-flight sessions keep
    -- the version they were created against.
    CREATE TABLE IF NOT EXISTS managed_agents (
      purpose TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_config_hash TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- One row per UTC date the nightly volume backup succeeded. Used by the
    -- scheduler to decide whether to fire a catch-up run on boot (last
    -- success missing or > 25h old). bytes is informational; the prune job
    -- works off S3 object names, not this table.
    CREATE TABLE IF NOT EXISTS backup_runs (
      utc_date TEXT PRIMARY KEY,
      succeeded_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL
    );
  `);
  // Light-touch column migrations for users — older DBs (pre-email-
  // verification, pre-terms-acceptance) already have a `users` table from
  // the original CREATE TABLE IF NOT EXISTS, which means new columns added
  // to the schema above won't appear. Add them defensively. SQLite raises
  // "duplicate column" if they already exist; swallow that.
  for (const col of [
    "email_verified_at INTEGER",
    "accepted_terms_at INTEGER",
    "pending_email TEXT",
    // When the user clicked "Sign up for early access" on the Comparison
    // page. Used both to display "Added to early access" on subsequent
    // visits and to query who's interested in the comparison feature.
    "early_access_at INTEGER",
    // Google's stable subject ID for users who signed in with Google.
    // NULL for password-only accounts. The unique index is partial so
    // many NULLs don't collide.
    "google_sub TEXT",
  ]) {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col};`); } catch { /* already exists */ }
  }
  // Partial unique index covers existing DBs that just got the column added.
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx
       ON users(google_sub) WHERE google_sub IS NOT NULL;`,
    );
  } catch { /* ignore */ }

  _db = db;
  _dbPath = targetPath;
  return db;
}

/** Test hook — call between tests to reset state. Tests pass DB_PATH override via env. */
export function _resetDbForTest(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
    _dbPath = null;
  }
}

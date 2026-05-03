/**
 * User notifications for terminal negotiation states.
 *
 * Two channels:
 *   - In-app: durable JSONL record at out/users/<id>/notifications/inbox.jsonl.
 *     Always written first, before any external call. The dashboard `/inbox`
 *     view reads this. Loss-tolerant: a write failure here is the loud kind
 *     of bug and should not be papered over.
 *   - Email: best-effort send via Resend, gated on `tune.email_digest`.
 *     Single retry after 30s on failure. A second failure logs to
 *     `notifications/failures.jsonl` and gives up — we'd rather have the
 *     in-app record visible than retry forever.
 *
 * Email batching: if the same user has 2+ in-app notifications in the last
 * BATCH_WINDOW_MS that have not yet been emailed, the next email send sweeps
 * all of them into one digest email ("3 bills need your call") and stamps
 * each record with `email_sent_at`. Single-notification senders get the
 * per-bill subject ("Bonsai resolved your bill: <provider>").
 *
 * Batching is at email-send time, not queue time — there's no background
 * scheduler. Each terminal-state event invokes notifyUser() once; the
 * decision of "single email or rolled-up email" is made then and there
 * based on the inbox file.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userPaths } from "./user-paths.ts";

export type NotificationKind = "resolved" | "awaiting_user_review" | "escalated";

export interface NotificationInput {
  user_id: string;
  thread_id: string;
  kind: NotificationKind;
  provider_name: string;
  /** One-sentence plain-English summary of what happened. */
  summary: string;
  /** Optional dollar amount to render in the subject + body. */
  amount?: number;
  /** Optional deep link back into the app. */
  deep_link?: string;
  /** When true, the rep asked the user to sign something binding. The
   * email subject + body call this out explicitly. Always gates regardless
   * of mode (caller has already converted requires_signature into
   * `awaiting_user_review`). */
  requires_signature?: boolean;
  signature_doc_summary?: string;
}

export interface NotificationRecord extends NotificationInput {
  id: string;
  created_at: string;
  /** Stamped when the email leaves notifyUser() successfully. Null for
   * either "skipped (email_digest off)" or "in-flight / failed". */
  email_sent_at: string | null;
  /** Stamped when this record was rolled into a digest with siblings.
   * The digest email lists all batched records by their thread_id. */
  email_batched_with?: string[];
  /** Last attempt error, if any. Cleared on success. */
  last_error?: string;
}

export interface NotifyDeps {
  /** Override the Resend send. Tests inject a fake. */
  sendEmail?: (msg: NotifyEmail) => Promise<void>;
  /** Override the wall-clock now. Tests freeze time to assert batching. */
  now?: () => Date;
  /** Override the retry delay. Tests pass 0 to skip the 30s wait. */
  retryDelayMs?: number;
}

export interface NotifyEmail {
  to: string;
  subject: string;
  text: string;
}

const BATCH_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const RETRY_DELAY_MS_DEFAULT = 30_000;

function inboxPath(user_id: string): string {
  return join(userPaths(user_id).baseDir, "notifications", "inbox.jsonl");
}

function failuresPath(user_id: string): string {
  return join(userPaths(user_id).baseDir, "notifications", "failures.jsonl");
}

function ensureDir(path: string): void {
  const dir = path.substring(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
}

export function readInbox(user_id: string): NotificationRecord[] {
  const path = inboxPath(user_id);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as NotificationRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is NotificationRecord => r !== null);
}

function writeInbox(user_id: string, records: NotificationRecord[]): void {
  const path = inboxPath(user_id);
  ensureDir(path);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
}

function appendFailure(user_id: string, payload: object): void {
  const path = failuresPath(user_id);
  ensureDir(path);
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
}

function newNotificationId(): string {
  return `ntf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the per-bill email body. Kind-specific subject + body templates
 * keep the wire output deterministic and unit-testable.
 */
function buildSingleEmail(rec: NotificationRecord, userEmail: string): NotifyEmail {
  const sigSuffix = rec.requires_signature ? " (signature required)" : "";
  const subject =
    rec.kind === "resolved"
      ? `Bonsai resolved your bill: ${rec.provider_name}${sigSuffix}`
      : rec.kind === "awaiting_user_review"
        ? `Bonsai needs your call: ${rec.provider_name}${sigSuffix}`
        : `Bonsai escalated: ${rec.provider_name}`;

  const lines: string[] = [];
  if (rec.kind === "resolved") {
    lines.push(`We resolved your negotiation with ${rec.provider_name}.`);
    lines.push("");
    lines.push(rec.summary);
    if (rec.amount != null) lines.push(`Final amount: $${rec.amount.toFixed(2)}`);
  } else if (rec.kind === "awaiting_user_review") {
    if (rec.requires_signature) {
      lines.push(`The rep at ${rec.provider_name} is asking you to sign something. We won't accept on your behalf.`);
      if (rec.signature_doc_summary) {
        lines.push("");
        lines.push(`What they're asking you to sign: ${rec.signature_doc_summary}`);
      }
    } else {
      lines.push(`We've reached what looks like a resolution with ${rec.provider_name}.`);
    }
    lines.push("");
    lines.push(rec.summary);
    if (rec.amount != null) lines.push(`Proposed amount: $${rec.amount.toFixed(2)}`);
  } else {
    lines.push(`We need your input on the negotiation with ${rec.provider_name}.`);
    lines.push("");
    lines.push(rec.summary);
  }
  if (rec.deep_link) {
    lines.push("");
    lines.push(`Open Bonsai: ${rec.deep_link}`);
  }
  return { to: userEmail, subject, text: lines.join("\n") };
}

/**
 * Build a digest email rolling up multiple recent un-emailed notifications.
 * Subject says how many bills need attention; body lists each one.
 */
function buildDigestEmail(records: NotificationRecord[], userEmail: string): NotifyEmail {
  const needsCall = records.filter((r) => r.kind === "awaiting_user_review");
  const resolved = records.filter((r) => r.kind === "resolved");
  const escalated = records.filter((r) => r.kind === "escalated");
  const parts: string[] = [];
  const counts: string[] = [];
  if (needsCall.length) counts.push(`${needsCall.length} need${needsCall.length === 1 ? "s" : ""} your call`);
  if (resolved.length) counts.push(`${resolved.length} resolved`);
  if (escalated.length) counts.push(`${escalated.length} escalated`);
  const subject = `Bonsai update: ${counts.join(", ")}`;

  if (needsCall.length) {
    parts.push("Need your call:");
    for (const r of needsCall) {
      const sig = r.requires_signature ? " (signature required)" : "";
      const amt = r.amount != null ? ` — $${r.amount.toFixed(2)}` : "";
      parts.push(`- ${r.provider_name}${sig}${amt}: ${r.summary}`);
    }
    parts.push("");
  }
  if (resolved.length) {
    parts.push("Resolved:");
    for (const r of resolved) {
      const amt = r.amount != null ? ` — $${r.amount.toFixed(2)}` : "";
      parts.push(`- ${r.provider_name}${amt}: ${r.summary}`);
    }
    parts.push("");
  }
  if (escalated.length) {
    parts.push("Escalated:");
    for (const r of escalated) {
      parts.push(`- ${r.provider_name}: ${r.summary}`);
    }
    parts.push("");
  }
  const link = records.find((r) => r.deep_link)?.deep_link;
  if (link) parts.push(`Open Bonsai: ${link}`);
  return { to: userEmail, subject, text: parts.join("\n") };
}

/**
 * Default email sender — POSTs to Resend using the same auth as outbound.
 * Keeps the transport identical so a Resend outage takes BOTH paths down
 * (acceptable single-point-of-failure risk per the plan).
 */
async function defaultSendEmail(msg: NotifyEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    // Treat as dev-mode no-op; the in-app record is still durable.
    console.warn("[notify-user] RESEND_API_KEY/RESEND_FROM unset — skipping email");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend notify send failed: ${res.status} ${text}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fire-and-record a user notification. Returns the persisted record.
 *
 * Order of operations:
 *  1. Read the user's tune config (skip-email gate).
 *  2. Read inbox; figure out whether to single-send or batch with siblings.
 *  3. Append the new record to inbox (DURABLE — happens before any send).
 *  4. If email_digest is on AND we have a destination email, attempt send.
 *     On failure, sleep retryDelayMs and retry once. On second failure,
 *     log to failures.jsonl and continue.
 *  5. Stamp email_sent_at on the new record (and any batched siblings).
 */
export async function notifyUser(
  input: NotificationInput,
  deps: NotifyDeps = {},
): Promise<NotificationRecord> {
  const now = (deps.now ?? (() => new Date()))();
  const sendEmail = deps.sendEmail ?? defaultSendEmail;
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS_DEFAULT;
  // Read the user's email_digest preference directly off disk. We can't
  // use getTuneConfig() because that resolves the user via
  // AsyncLocalStorage; this function is called from background contexts
  // (webhook step, persistent-advance sweep) that don't have a request
  // scope. Read order matches user-settings.ts's getTuneConfig().
  const tune = readTuneFromDisk(input.user_id);

  const record: NotificationRecord = {
    id: newNotificationId(),
    created_at: now.toISOString(),
    email_sent_at: null,
    ...input,
  };

  // 3. Durable in-app write FIRST.
  const inbox = readInbox(input.user_id);
  inbox.push(record);
  writeInbox(input.user_id, inbox);

  // 4. Email gate.
  if (!tune.email_digest) return record;
  // We need a destination email. Use cc/from convention from the existing
  // negotiation pipeline — the user's email is whatever the caller passed
  // as user_email on the thread state. We read it from a short-lived hint
  // in process.env if present, else the input.deep_link host doesn't help.
  // Realistically the caller should pass it. For now, look up from settings
  // (profile.email).
  const destination = await resolveUserEmail(input.user_id);
  if (!destination) {
    appendFailure(input.user_id, {
      record_id: record.id,
      reason: "no_destination_email",
      thread_id: input.thread_id,
    });
    return record;
  }

  // Find recent un-emailed siblings to batch with.
  const cutoff = now.getTime() - BATCH_WINDOW_MS;
  const siblings = inbox.filter(
    (r) =>
      r.id !== record.id &&
      r.email_sent_at === null &&
      Date.parse(r.created_at) >= cutoff,
  );
  const batch = [record, ...siblings];

  const msg =
    batch.length > 1
      ? buildDigestEmail(batch, destination)
      : buildSingleEmail(record, destination);

  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < 2) {
    try {
      await sendEmail(msg);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt < 2 && retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }

  if (lastErr) {
    appendFailure(input.user_id, {
      record_id: record.id,
      thread_id: input.thread_id,
      reason: "send_failed",
      error: String(lastErr instanceof Error ? lastErr.message : lastErr),
    });
    record.last_error = String(lastErr instanceof Error ? lastErr.message : lastErr);
    // Persist the error onto the record so the UI can show "(email delivery failed)".
    const i = inbox.findIndex((r) => r.id === record.id);
    if (i >= 0) inbox[i] = record;
    writeInbox(input.user_id, inbox);
    return record;
  }

  // 5. Stamp email_sent_at on the new record + every sibling that was
  // rolled into the digest. Keep references to siblings via
  // email_batched_with so the UI can see the digest grouping.
  const batchedIds = batch.map((r) => r.id);
  const sentAt = new Date().toISOString();
  for (const r of inbox) {
    if (batchedIds.includes(r.id)) {
      r.email_sent_at = sentAt;
      if (batchedIds.length > 1) r.email_batched_with = batchedIds.filter((x) => x !== r.id);
    }
  }
  writeInbox(input.user_id, inbox);
  record.email_sent_at = sentAt;
  if (batchedIds.length > 1) record.email_batched_with = batchedIds.filter((x) => x !== record.id);
  return record;
}

/**
 * Read the user's tune preferences directly off disk, bypassing the
 * AsyncLocalStorage-backed getTuneConfig(). Background callers
 * (webhooks, sweeps) don't have a request context. Defaults match
 * user-settings.ts so the two paths agree on a fresh install.
 */
function readTuneFromDisk(user_id: string): { email_digest: boolean } {
  const settingsPath = userPaths(user_id).settingsPath;
  if (!existsSync(settingsPath)) return { email_digest: true };
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      tune?: { email_digest?: boolean };
      notify_email_digest?: boolean;
    };
    const t = raw.tune ?? {};
    if (t.email_digest !== undefined) return { email_digest: !!t.email_digest };
    if (raw.notify_email_digest !== undefined) return { email_digest: raw.notify_email_digest !== false };
    return { email_digest: true };
  } catch {
    return { email_digest: true };
  }
}

/**
 * Resolve the user's destination email for notifications. Read order:
 *  1. profile.email (set in Profile tab)
 *  2. (future: account email from auth — not currently exposed by lib/auth)
 *
 * AsyncLocalStorage is required for getProfileConfig — when called outside
 * a request context (e.g., the persistent-advance sweep) we read settings
 * directly off disk via userPaths.
 */
async function resolveUserEmail(user_id: string): Promise<string | null> {
  const settingsPath = userPaths(user_id).settingsPath;
  if (!existsSync(settingsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      profile?: { email?: string };
      account_email?: string;
    };
    const email = raw.profile?.email?.trim() || raw.account_email?.trim() || null;
    return email && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

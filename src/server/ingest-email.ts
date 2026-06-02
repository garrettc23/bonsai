/**
 * Email-forwarding bill ingestion (Workstream A2).
 *
 * The autonomy vision needs bills to ARRIVE without a manual upload. The
 * lowest-consent, fastest-to-ship channel (and the one that reuses the Resend
 * inbound webhook we already run): the user forwards a bill to a per-account
 * ingest alias like `bills+<userId>@ingest.bonsai...`, and Bonsai picks it up.
 *
 * This module is the ingestion CORE: identify which user a forward belongs
 * to, pull the bill attachment, and hand it to the pipeline — or, on any
 * problem, SURFACE the failure. The audit's failure mode for ingestion was
 * "bill arrives, parse fails, silently dropped." Every unhappy path here
 * routes through deps.onDropped; nothing is ever silently lost.
 *
 * Deps are injected so the core is pure and unit-testable. The HTTP binding
 * (a route that verifies the Resend signature and decodes attachments) and
 * the audit kick-off are the remaining integration — both reuse existing
 * machinery (src/server/webhooks.ts signature verify; runAuditPhase).
 */
import { getUserById, type User } from "../lib/auth.ts";
import { getDb } from "../lib/db.ts";

export interface ForwardedAttachment {
  filename: string;
  content_type?: string;
  /** Base64-encoded file bytes, as Resend inbound delivers them. */
  content_base64: string;
}

export interface ForwardedEmail {
  /** Recipient addresses — one of them is the ingest alias. */
  to: string[];
  /** Who forwarded it (the account holder, normally). */
  from: string;
  subject?: string;
  attachments?: ForwardedAttachment[];
}

export type IngestResult =
  | { ok: true; user_id: string; filename: string }
  | { ok: false; reason: "unroutable" | "no_pdf_attachment"; detail: string };

export interface IngestDeps {
  /** Resolve the Bonsai user from the ingest alias the mail was sent to. */
  resolveUser: (toAddresses: string[]) => User | null;
  /** Hand a received bill to the audit pipeline. */
  onBillReceived: (args: {
    user: User;
    filename: string;
    content_base64: string;
    from: string;
  }) => Promise<void> | void;
  /** Surface an unroutable / unparseable forward so it is NEVER silently
   * dropped — dead-letter, ops alert, or a bounce back to the sender. */
  onDropped: (args: { reason: string; from: string; to: string[] }) => Promise<void> | void;
}

/**
 * Idempotency gate. Records a Resend message_id the first time we see it and
 * returns true; a re-delivery of the same id returns false so the caller
 * skips it. A provider retrying a webhook must never spawn a second audit or
 * negotiation. Empty/missing id → always processed (can't dedup what we
 * can't key).
 */
export function claimMessageForIngest(messageId: string | undefined, userId?: string): boolean {
  if (!messageId) return true;
  const res = getDb()
    .query(
      "INSERT INTO ingested_messages (message_id, user_id, received_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING",
    )
    .run(messageId, userId ?? null, Date.now());
  return res.changes > 0;
}

/** Ingest alias pattern: `bills+<userId>@<anything>`. */
export const INGEST_ALIAS_RE = /\bbills\+([a-z0-9_-]+)@/i;

/** Extract a userId from a plus-addressed ingest alias in any recipient. */
export function userIdFromIngestAddresses(to: string[]): string | null {
  for (const addr of to) {
    const m = addr.match(INGEST_ALIAS_RE);
    if (m) return m[1];
  }
  return null;
}

/** Production resolver: ingest-alias → userId → User row. */
export function defaultResolveUser(toAddresses: string[]): User | null {
  const id = userIdFromIngestAddresses(toAddresses);
  return id ? getUserById(id) : null;
}

function firstPdf(atts?: ForwardedAttachment[]): ForwardedAttachment | null {
  if (!atts) return null;
  return (
    atts.find(
      (a) =>
        a.content_type?.toLowerCase().includes("pdf") || a.filename.toLowerCase().endsWith(".pdf"),
    ) ?? null
  );
}

/**
 * Ingest one forwarded email. Resolves the owner, extracts the first PDF, and
 * hands it off — or surfaces a drop. Returns a structured result either way so
 * the HTTP layer can ack/bounce appropriately.
 */
export async function ingestForwardedEmail(
  email: ForwardedEmail,
  deps: IngestDeps,
): Promise<IngestResult> {
  const user = deps.resolveUser(email.to);
  if (!user) {
    await deps.onDropped({
      reason: "unroutable: no Bonsai user matched the ingest address",
      from: email.from,
      to: email.to,
    });
    return { ok: false, reason: "unroutable", detail: "no user matched ingest address" };
  }

  const pdf = firstPdf(email.attachments);
  if (!pdf) {
    await deps.onDropped({
      reason: "no PDF attachment on forwarded email",
      from: email.from,
      to: email.to,
    });
    return { ok: false, reason: "no_pdf_attachment", detail: "forwarded email had no PDF bill attached" };
  }

  await deps.onBillReceived({
    user,
    filename: pdf.filename,
    content_base64: pdf.content_base64,
    from: email.from,
  });
  return { ok: true, user_id: user.id, filename: pdf.filename };
}

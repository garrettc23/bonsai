/**
 * Resend inbound webhook handler.
 *
 * Resend posts parsed inbound email to this endpoint as an `email.received`
 * event signed with svix. Flow:
 *
 *   1. Verify svix signature against RESEND_WEBHOOK_SECRET (constant-time).
 *      → 401 if invalid; this is the trust boundary.
 *   2. Parse the payload, extract message_id + thread correlation.
 *      Correlation order: X-Bonsai-Thread-Id header → In-Reply-To → References.
 *      → 202 if no correlation can be made (we accept the delivery so Resend
 *         doesn't keep retrying, but we don't act).
 *   3. Append-idempotent into out/threads/{thread_id}.json keyed on message_id.
 *      → 200 even on duplicate (idempotent success).
 *   4. Trigger one stepNegotiation against the saved NegotiationState so the
 *      UI updates immediately, no polling lag.
 *
 * Env:
 *   RESEND_WEBHOOK_SECRET — base64 of the Svix signing secret. If missing,
 *     verification is SKIPPED with a warning. That mode is meant for local
 *     development against `bun run serve`; production sets the secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadNegotiationState,
  saveNegotiationState,
  stepNegotiation,
} from "../negotiate-email.ts";
import {
  appendInboundIdempotent,
  withThreadLock,
} from "../lib/thread-store.ts";
import { loadThread } from "../clients/email-mock.ts";
import type { InboundEmail } from "../clients/email.ts";
import { autoEmailClient } from "../clients/email-resend.ts";
import { dataRoot } from "../lib/user-paths.ts";
import { withUserContext } from "../lib/user-context.ts";
import { getUserById } from "../lib/auth.ts";

interface ResendInboundPayload {
  type?: string;
  created_at?: string;
  data?: {
    from?: { email?: string } | string;
    to?: Array<{ email?: string } | string> | string;
    cc?: Array<{ email?: string } | string> | string;
    subject?: string;
    text?: string;
    html?: string;
    headers?: Array<{ name: string; value: string }>;
    message_id?: string;
    in_reply_to?: string;
    references?: string | string[];
  };
}

function pickHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lc = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lc)?.value;
}

function emailString(v: { email?: string } | string | undefined): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  return v.email ?? "";
}

function emailList(
  v: Array<{ email?: string } | string> | string | undefined,
): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  return v.map(emailString).filter((s) => s.length > 0);
}

/** Resolve the user owning this threads dir, then pull their profile
 * email. Returns null when we can't (legacy thread dir, deleted user,
 * unset profile). */
async function resolveUserProfileEmail(threadsDir: string): Promise<string | null> {
  const userId = userIdFromThreadsDir(threadsDir);
  if (!userId) return null;
  const user = getUserById(userId);
  if (!user) return null;
  return await withUserContext(user, async () => {
    const { getProfileConfig } = await import("../lib/user-settings.ts");
    return getProfileConfig().email;
  });
}

/** Send a "the rep replied" forward to the user's inbox so they see the
 * conversation natively without having to check the Bonsai dashboard.
 * Skipped when the user is already on the inbound's To/Cc (Reply-All path,
 * they already have it) or when Resend isn't configured. */
async function forwardInboundToUser(opts: {
  inbound: InboundEmail;
  rawTo: string[];
  rawCc: string[];
  threadsDir: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return;
  const userEmail = await resolveUserProfileEmail(opts.threadsDir);
  if (!userEmail) return;
  const userEmailLc = userEmail.toLowerCase();
  const alreadyOn = [...opts.rawTo, ...opts.rawCc].some(
    (e) => e.toLowerCase() === userEmailLc,
  );
  if (alreadyOn) return;
  const subject = opts.inbound.subject.startsWith("Fwd: ")
    ? opts.inbound.subject
    : `Fwd: ${opts.inbound.subject}`;
  const body = [
    `Bonsai received this reply on the bill it's negotiating for you.`,
    ``,
    `From: ${opts.inbound.from}`,
    `Subject: ${opts.inbound.subject}`,
    `Received: ${opts.inbound.received_at}`,
    ``,
    `─────────────────────────`,
    ``,
    opts.inbound.body_text,
    ``,
    `─────────────────────────`,
    ``,
    `The agent has read this and is composing the next round.`,
    `Open Bonsai to follow along: https://${process.env.BONSAI_PUBLIC_DOMAIN ?? "your-bonsai-domain.com"}/`,
  ].join("\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [userEmail],
        subject,
        text: body,
        headers: {
          "X-Bonsai-Thread-Id": opts.inbound.thread_id,
          "X-Bonsai-Forward": "1",
        },
      }),
    });
    if (!res.ok) {
      console.warn(
        `[webhook] forward to ${userEmail} failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
  } catch (err) {
    console.warn(`[webhook] forward to ${userEmail} threw:`, (err as Error).message);
  }
}

function correlateThreadId(payload: ResendInboundPayload): string | null {
  return correlateThreadIdWithMethod(payload).thread_id;
}

type CorrelationMethod = "header" | "in_reply_to" | "references" | null;

function correlateThreadIdWithMethod(
  payload: ResendInboundPayload,
): { thread_id: string | null; method: CorrelationMethod } {
  const data = payload.data ?? {};
  const fromHeader = pickHeader(data.headers, "X-Bonsai-Thread-Id");
  if (fromHeader) return { thread_id: fromHeader, method: "header" };
  const inReplyTo = data.in_reply_to ?? pickHeader(data.headers, "In-Reply-To");
  if (inReplyTo) {
    const tid = lookupThreadByOutboundMessageId(inReplyTo);
    if (tid) return { thread_id: tid, method: "in_reply_to" };
  }
  const refsRaw = data.references ?? pickHeader(data.headers, "References");
  const refs = Array.isArray(refsRaw)
    ? refsRaw
    : refsRaw
      ? refsRaw.split(/\s+/)
      : [];
  for (const r of refs) {
    const tid = lookupThreadByOutboundMessageId(r);
    if (tid) return { thread_id: tid, method: "references" };
  }
  return { thread_id: null, method: null };
}

/** Every per-user threads directory plus the legacy `dataRoot/threads`
 * fallback. Used to find which user owns an inbound thread (the webhook
 * is unauthenticated so we have no session to point at the right user). */
function allThreadsDirs(): string[] {
  const root = dataRoot();
  const out: string[] = [];
  const legacy = join(root, "threads");
  if (existsSync(legacy)) out.push(legacy);
  const usersDir = join(root, "users");
  if (existsSync(usersDir)) {
    for (const userId of readdirSync(usersDir)) {
      const td = join(usersDir, userId, "threads");
      if (existsSync(td)) out.push(td);
    }
  }
  return out;
}

/** Find which on-disk threads directory holds {thread_id}.json. */
function locateThreadsDir(thread_id: string): string | null {
  for (const dir of allThreadsDirs()) {
    if (existsSync(join(dir, `${thread_id}.json`))) return dir;
  }
  return null;
}

/** Extract the user id from a per-user threads dir path. Returns null
 * for the legacy out/threads/ root. Format: {dataRoot}/users/{id}/threads */
function userIdFromThreadsDir(threadsDir: string): string | null {
  const m = threadsDir.match(/users[\\/]([a-zA-Z0-9_-]+)[\\/]threads$/);
  return m?.[1] ?? null;
}

/** Scan every user's threads dir for an outbound message_id match.
 * Linear in (users × threads); fine for demo scale. */
function lookupThreadByOutboundMessageId(messageId: string): string | null {
  const id = messageId.replace(/^<|>$/g, "").trim();
  for (const dir of allThreadsDirs()) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.endsWith(".state.json")) continue;
      const tid = f.slice(0, -".json".length);
      const t = loadThread(tid, dir);
      if (t.outbound.some((m) => m.message_id === id)) return tid;
    }
  }
  return null;
}

/**
 * Verify a Svix-signed payload. Resend signs inbound webhooks with svix.
 * The signature is HMAC-SHA256 of `${id}.${timestamp}.${body}` using the
 * decoded secret, base64-encoded. Multiple signatures may appear, space-
 * separated, formatted "v1,<base64>" — we accept any match.
 */
export function verifySvixSignature(opts: {
  secret: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  body: string;
}): boolean {
  const { secret, svixId, svixTimestamp, svixSignature, body } = opts;
  if (!svixId || !svixTimestamp || !svixSignature) return false;
  // Reject replayed payloads older than 5 minutes (svix recommendation).
  const tsSec = Number(svixTimestamp);
  if (!Number.isFinite(tsSec)) return false;
  const ageSec = Math.abs(Date.now() / 1000 - tsSec);
  if (ageSec > 5 * 60) return false;
  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");
  const toSign = `${svixId}.${svixTimestamp}.${body}`;
  const expected = createHmac("sha256", secretBytes).update(toSign).digest();
  for (const piece of svixSignature.split(" ")) {
    const [, b64] = piece.split(",", 2);
    if (!b64) continue;
    let got: Buffer;
    try {
      got = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (got.length === expected.length && timingSafeEqual(got, expected)) {
      return true;
    }
  }
  return false;
}

export async function handleResendInbound(req: Request): Promise<Response> {
  const body = await req.text();

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const ok = verifySvixSignature({
      secret,
      svixId: req.headers.get("svix-id") ?? "",
      svixTimestamp: req.headers.get("svix-timestamp") ?? "",
      svixSignature: req.headers.get("svix-signature") ?? "",
      body,
    });
    if (!ok) {
      return Response.json({ error: "invalid signature" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Fail closed in prod even if the operator forgot to set the secret.
    return Response.json(
      { error: "RESEND_WEBHOOK_SECRET not configured" },
      { status: 500 },
    );
  } else {
    console.warn(
      "[webhook] RESEND_WEBHOOK_SECRET not set — accepting inbound without verification (dev only)",
    );
  }

  let payload: ResendInboundPayload;
  try {
    payload = JSON.parse(body) as ResendInboundPayload;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  // Resend uses `email.received` for inbound. Be permissive: also accept
  // payloads without a type for tunnel-driven curl tests.
  if (payload.type && !/^email\.(received|inbound)/i.test(payload.type)) {
    return Response.json({ ok: true, ignored: payload.type });
  }

  const data = payload.data ?? {};
  const thread_id = correlateThreadId(payload);
  const message_id =
    data.message_id ??
    pickHeader(data.headers, "Message-Id") ??
    `in_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  if (!thread_id) {
    console.warn(
      `[webhook] no thread correlation for inbound message_id=${message_id}; accepted but dropped.`,
    );
    return Response.json({ ok: true, correlated: false }, { status: 202 });
  }

  const rawTo = emailList(data.to);
  const rawCc = emailList(data.cc);
  const inbound: InboundEmail = {
    message_id: message_id.replace(/^<|>$/g, ""),
    received_at: payload.created_at ?? new Date().toISOString(),
    from: emailString(data.from),
    to: rawTo[0] ?? "",
    subject: data.subject ?? "(no subject)",
    body_text: data.text ?? data.html ?? "",
    thread_id,
    in_reply_to: data.in_reply_to,
  };

  // Find which user's threads dir owns this thread, so the inbound lands
  // in the right per-user tree.
  const threadsDir = locateThreadsDir(thread_id) ?? undefined;
  const { inserted } = await appendInboundIdempotent(thread_id, inbound, threadsDir);

  if (inserted) {
    // Fire-and-forget the agent step so the webhook returns fast (Resend
    // expects 2xx within 5s). The step writes its own state on completion.
    void stepInBackground(thread_id, threadsDir);
    // Backstop forward to the user's inbox. Skipped when they were already
    // CC'd on the inbound (Reply-All) so we don't dupe. Also skipped on
    // the legacy `out/threads/` path since we have no user to resolve.
    if (threadsDir) {
      void forwardInboundToUser({ inbound, rawTo, rawCc, threadsDir });
    }
  }

  return Response.json({ ok: true, correlated: true, inserted, thread_id });
}

/**
 * Read-only debug echo for `POST /webhooks/resend-inbound/echo`. Returns
 * what the production handler would observe — signature validity, age,
 * thread correlation method — without persisting anything or stepping
 * the agent. Gated by `BONSAI_WEBHOOK_DEBUG_TOKEN`: route returns 404
 * when the env var is unset, missing, or doesn't match `?debug_token=`.
 */
export async function handleResendInboundEcho(req: Request): Promise<Response> {
  const expectedToken = process.env.BONSAI_WEBHOOK_DEBUG_TOKEN;
  if (!expectedToken) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  const providedToken = url.searchParams.get("debug_token") ?? "";
  if (!constantTimeStringEqual(providedToken, expectedToken)) {
    return new Response("Not found", { status: 404 });
  }

  const body = await req.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const svixId = req.headers.get("svix-id") ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";

  const tsSec = Number(svixTimestamp);
  const ageSeconds = Number.isFinite(tsSec)
    ? Math.abs(Date.now() / 1000 - tsSec)
    : null;

  const signatureValid = secret
    ? verifySvixSignature({
        secret,
        svixId,
        svixTimestamp,
        svixSignature,
        body,
      })
    : false;

  let parsed: ResendInboundPayload | null = null;
  try {
    parsed = JSON.parse(body) as ResendInboundPayload;
  } catch {
    parsed = null;
  }

  const correlation = parsed
    ? correlateThreadIdWithMethod(parsed)
    : { thread_id: null, method: null as CorrelationMethod };

  return Response.json({
    secret_configured: Boolean(secret),
    svix_id: svixId,
    svix_timestamp: svixTimestamp,
    age_seconds: ageSeconds,
    signature_valid: signatureValid,
    body_bytes: Buffer.byteLength(body, "utf8"),
    thread_correlation: {
      method: correlation.method,
      thread_id: correlation.thread_id,
    },
  });
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function stepInBackground(thread_id: string, threadsDir?: string): Promise<void> {
  try {
    await withThreadLock(thread_id, async () => {
      const state = loadNegotiationState(thread_id, threadsDir);
      if (!state) {
        console.warn(`[webhook] no NegotiationState on disk for ${thread_id}`);
        return;
      }
      if (state.outcome.status !== "in_progress") return;
      const client = await autoEmailClient(threadsDir);
      const next = await stepNegotiation({ state, client, threadsDir });
      saveNegotiationState(next, threadsDir);
    });
  } catch (err) {
    console.error(`[webhook] step failed for ${thread_id}:`, err);
  }
}

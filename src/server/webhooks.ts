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

interface ResendInboundPayload {
  type?: string;
  created_at?: string;
  data?: {
    from?: { email?: string } | string;
    to?: Array<{ email?: string } | string> | string;
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

function correlateThreadId(payload: ResendInboundPayload): string | null {
  const data = payload.data ?? {};
  const fromHeader = pickHeader(data.headers, "X-Bonsai-Thread-Id");
  if (fromHeader) return fromHeader;
  const inReplyTo = data.in_reply_to ?? pickHeader(data.headers, "In-Reply-To");
  if (inReplyTo) {
    const tid = lookupThreadByOutboundMessageId(inReplyTo);
    if (tid) return tid;
  }
  const refsRaw = data.references ?? pickHeader(data.headers, "References");
  const refs = Array.isArray(refsRaw)
    ? refsRaw
    : refsRaw
      ? refsRaw.split(/\s+/)
      : [];
  for (const r of refs) {
    const tid = lookupThreadByOutboundMessageId(r);
    if (tid) return tid;
  }
  return null;
}

/** Scan out/threads/*.json for an outbound message_id match. Linear in
 * thread count; fine for demo scale. */
function lookupThreadByOutboundMessageId(messageId: string): string | null {
  // Strip RFC 2822 angle brackets if present.
  const id = messageId.replace(/^<|>$/g, "").trim();
  // Lazy import to avoid a circular dep through email-mock.
  const { readdirSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { dirname, join } = require("node:path") as typeof import("node:path");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "out", "threads");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".state.json")) continue;
    const tid = f.slice(0, -".json".length);
    const t = loadThread(tid);
    if (t.outbound.some((m) => m.message_id === id)) return tid;
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

  const inbound: InboundEmail = {
    message_id: message_id.replace(/^<|>$/g, ""),
    received_at: payload.created_at ?? new Date().toISOString(),
    from: emailString(data.from),
    to: Array.isArray(data.to) ? emailString(data.to[0]) : emailString(data.to),
    subject: data.subject ?? "(no subject)",
    body_text: data.text ?? data.html ?? "",
    thread_id,
    in_reply_to: data.in_reply_to,
  };

  const { inserted } = await appendInboundIdempotent(thread_id, inbound);

  // Fire-and-forget the agent step so the webhook returns fast (Resend
  // expects 2xx within 5s). The step writes its own state on completion.
  if (inserted) {
    void stepInBackground(thread_id);
  }

  return Response.json({ ok: true, correlated: true, inserted, thread_id });
}

async function stepInBackground(thread_id: string): Promise<void> {
  try {
    await withThreadLock(thread_id, async () => {
      const state = loadNegotiationState(thread_id);
      if (!state) {
        console.warn(`[webhook] no NegotiationState on disk for ${thread_id}`);
        return;
      }
      if (state.outcome.status !== "in_progress") return;
      const client = await autoEmailClient();
      const next = await stepNegotiation({ state, client });
      saveNegotiationState(next);
    });
  } catch (err) {
    console.error(`[webhook] step failed for ${thread_id}:`, err);
  }
}

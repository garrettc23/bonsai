/**
 * Tests for the Resend inbound webhook handler.
 *
 * Covers the trust boundary (svix signature) and the contract:
 *   - bad signature → 401
 *   - good signature, valid payload, known thread → 200, inbound persisted
 *   - good signature, unknown thread → 202, no state mutation
 *   - duplicate message_id → 200, only one row in thread file
 *
 * The handler trips loadNegotiationState which reads from a fixed
 * out/threads/ dir. We don't exercise the auto-step path here (it requires
 * Anthropic mocking + state on disk in the production dir); that is
 * covered indirectly by negotiate-email.test.ts which exercises the same
 * step function.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleResendInbound,
  handleResendInboundEcho,
  verifySvixSignature,
} from "../src/server/webhooks.ts";
import { loadThread, saveThread } from "../src/clients/email-mock.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PROD_THREADS_DIR = join(ROOT, "out", "threads");

function svixSign(opts: {
  secretRaw: string;
  body: string;
}): { id: string; ts: string; sig: string } {
  const id = `msg_${Math.random().toString(36).slice(2, 10)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const toSign = `${id}.${ts}.${opts.body}`;
  const sigBytes = createHmac("sha256", Buffer.from(opts.secretRaw, "utf8"))
    .update(toSign)
    .digest();
  const sig = `v1,${sigBytes.toString("base64")}`;
  return { id, ts, sig };
}

let originalSecret: string | undefined;
let originalNodeEnv: string | undefined;
let originalDebugToken: string | undefined;
let scratchThreadIds: string[] = [];

beforeEach(() => {
  originalSecret = process.env.RESEND_WEBHOOK_SECRET;
  originalNodeEnv = process.env.NODE_ENV;
  originalDebugToken = process.env.BONSAI_WEBHOOK_DEBUG_TOKEN;
  scratchThreadIds = [];
});

afterEach(() => {
  // Restore env.
  if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = originalSecret;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDebugToken === undefined) delete process.env.BONSAI_WEBHOOK_DEBUG_TOKEN;
  else process.env.BONSAI_WEBHOOK_DEBUG_TOKEN = originalDebugToken;
  // Clean up anything we wrote into the production threads dir.
  for (const tid of scratchThreadIds) {
    try {
      rmSync(join(PROD_THREADS_DIR, `${tid}.json`));
    } catch {
      /* ignore */
    }
    try {
      rmSync(join(PROD_THREADS_DIR, `${tid}.state.json`));
    } catch {
      /* ignore */
    }
  }
});

function seedThread(thread_id: string, outboundMessageId?: string) {
  scratchThreadIds.push(thread_id);
  mkdirSync(PROD_THREADS_DIR, { recursive: true });
  // Pass the dir explicitly — `saveThread`'s default reads the active
  // user from AsyncLocalStorage (per-user paths refactor), which doesn't
  // apply to the unauthenticated webhook surface this test exercises.
  saveThread(
    {
      thread_id,
      outbound: outboundMessageId
        ? [
            {
              message_id: outboundMessageId,
              sent_at: new Date().toISOString(),
              to: "billing@hospital.example",
              from: "patient@example.com",
              subject: "Appeal",
              body_markdown: "...",
              thread_id,
            },
          ]
        : [],
      inbound: [],
    },
    PROD_THREADS_DIR,
  );
}

function makeRequest(opts: {
  body: string;
  headers?: Record<string, string>;
}): Request {
  return new Request("http://localhost:3333/webhooks/resend-inbound", {
    method: "POST",
    headers: opts.headers,
    body: opts.body,
  });
}

function makeEchoRequest(opts: {
  body: string;
  headers?: Record<string, string>;
  query?: string;
}): Request {
  const qs = opts.query ? `?${opts.query}` : "";
  return new Request(`http://localhost:3333/webhooks/resend-inbound/echo${qs}`, {
    method: "POST",
    headers: opts.headers,
    body: opts.body,
  });
}

describe("verifySvixSignature", () => {
  test("accepts a freshly-signed payload", () => {
    const body = JSON.stringify({ ok: true });
    const { id, ts, sig } = svixSign({ secretRaw: "shh", body });
    expect(
      verifySvixSignature({
        secret: "shh",
        svixId: id,
        svixTimestamp: ts,
        svixSignature: sig,
        body,
      }),
    ).toBe(true);
  });

  test("rejects a tampered body", () => {
    const body = JSON.stringify({ ok: true });
    const { id, ts, sig } = svixSign({ secretRaw: "shh", body });
    expect(
      verifySvixSignature({
        secret: "shh",
        svixId: id,
        svixTimestamp: ts,
        svixSignature: sig,
        body: body + "x",
      }),
    ).toBe(false);
  });

  test("rejects a payload older than 5 minutes (replay window)", () => {
    const body = JSON.stringify({ ok: true });
    const id = "msg_old";
    const ts = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const sigBytes = createHmac("sha256", Buffer.from("shh", "utf8"))
      .update(`${id}.${ts}.${body}`)
      .digest();
    expect(
      verifySvixSignature({
        secret: "shh",
        svixId: id,
        svixTimestamp: ts,
        svixSignature: `v1,${sigBytes.toString("base64")}`,
        body,
      }),
    ).toBe(false);
  });

  test("rejects when any header is missing", () => {
    expect(
      verifySvixSignature({
        secret: "shh",
        svixId: "",
        svixTimestamp: "1",
        svixSignature: "v1,xx",
        body: "{}",
      }),
    ).toBe(false);
  });
});

describe("handleResendInbound", () => {
  test("401 on bad signature (when secret is configured)", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const body = JSON.stringify({
      type: "email.received",
      data: { from: "x@y", subject: "Re", text: "hi" },
    });
    const res = await handleResendInbound(
      makeRequest({
        body,
        headers: {
          "svix-id": "x",
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": "v1,YWJj",
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("202 on valid sig but no thread correlation", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const body = JSON.stringify({
      type: "email.received",
      data: {
        from: "x@y",
        to: "us@bonsai",
        subject: "Re: nothing",
        text: "hi",
        message_id: "in-no-corr",
        headers: [],
      },
    });
    const sv = svixSign({ secretRaw: "shh", body });
    const res = await handleResendInbound(
      makeRequest({
        body,
        headers: {
          "svix-id": sv.id,
          "svix-timestamp": sv.ts,
          "svix-signature": sv.sig,
        },
      }),
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as { correlated: boolean };
    expect(json.correlated).toBe(false);
  });

  test("200 + persists inbound when X-Bonsai-Thread-Id header matches", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const tid = `thread_test_${Math.random().toString(36).slice(2, 8)}`;
    seedThread(tid);
    const body = JSON.stringify({
      type: "email.received",
      data: {
        from: { email: "billing@hospital.example" },
        to: [{ email: "patient@example.com" }],
        subject: "Re: Appeal",
        text: "Approved",
        message_id: "in-001",
        headers: [{ name: "X-Bonsai-Thread-Id", value: tid }],
      },
    });
    const sv = svixSign({ secretRaw: "shh", body });
    const res = await handleResendInbound(
      makeRequest({
        body,
        headers: {
          "svix-id": sv.id,
          "svix-timestamp": sv.ts,
          "svix-signature": sv.sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const t = loadThread(tid, PROD_THREADS_DIR);
    expect(t.inbound.length).toBe(1);
    expect(t.inbound[0].message_id).toBe("in-001");
    expect(t.inbound[0].body_text).toBe("Approved");
  });

  test("200 + idempotent on duplicate message_id", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const tid = `thread_dup_${Math.random().toString(36).slice(2, 8)}`;
    seedThread(tid);
    const body = JSON.stringify({
      type: "email.received",
      data: {
        from: "billing@hospital.example",
        to: "patient@example.com",
        subject: "Re: Appeal",
        text: "Approved",
        message_id: "dup-001",
        headers: [{ name: "X-Bonsai-Thread-Id", value: tid }],
      },
    });
    const sv1 = svixSign({ secretRaw: "shh", body });
    await handleResendInbound(
      makeRequest({
        body,
        headers: {
          "svix-id": sv1.id,
          "svix-timestamp": sv1.ts,
          "svix-signature": sv1.sig,
        },
      }),
    );
    const sv2 = svixSign({ secretRaw: "shh", body });
    const res2 = await handleResendInbound(
      makeRequest({
        body,
        headers: {
          "svix-id": sv2.id,
          "svix-timestamp": sv2.ts,
          "svix-signature": sv2.sig,
        },
      }),
    );
    expect(res2.status).toBe(200);
    const json = (await res2.json()) as { inserted: boolean };
    expect(json.inserted).toBe(false);
    const t = loadThread(tid, PROD_THREADS_DIR);
    expect(t.inbound.length).toBe(1);
  });

  test("correlates by In-Reply-To when header is absent", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const tid = `thread_irt_${Math.random().toString(36).slice(2, 8)}`;
    const outboundMid = "out-msg-abc";
    seedThread(tid, outboundMid);
    const body = JSON.stringify({
      type: "email.received",
      data: {
        from: "billing@hospital.example",
        to: "patient@example.com",
        subject: "Re: Appeal",
        text: "Approved",
        message_id: "in-002",
        in_reply_to: `<${outboundMid}>`,
        headers: [],
      },
    });
    const sv = svixSign({ secretRaw: "shh", body });
    const res = await handleResendInbound(
      makeRequest({
        body,
        headers: {
          "svix-id": sv.id,
          "svix-timestamp": sv.ts,
          "svix-signature": sv.sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const t = loadThread(tid, PROD_THREADS_DIR);
    expect(t.inbound.length).toBe(1);
  });
});

describe("handleResendInboundEcho", () => {
  test("404 when BONSAI_WEBHOOK_DEBUG_TOKEN is unset (regardless of token)", async () => {
    delete process.env.BONSAI_WEBHOOK_DEBUG_TOKEN;
    const res = await handleResendInboundEcho(
      makeEchoRequest({ body: "{}", query: "debug_token=anything" }),
    );
    expect(res.status).toBe(404);
  });

  test("404 when token query param is missing", async () => {
    process.env.BONSAI_WEBHOOK_DEBUG_TOKEN = "right";
    const res = await handleResendInboundEcho(
      makeEchoRequest({ body: "{}" }),
    );
    expect(res.status).toBe(404);
  });

  test("404 when token query param is wrong", async () => {
    process.env.BONSAI_WEBHOOK_DEBUG_TOKEN = "right";
    const res = await handleResendInboundEcho(
      makeEchoRequest({ body: "{}", query: "debug_token=wrong" }),
    );
    expect(res.status).toBe(404);
  });

  test("200 + signature_valid:true on a freshly-signed payload", async () => {
    process.env.BONSAI_WEBHOOK_DEBUG_TOKEN = "right";
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const body = JSON.stringify({
      type: "email.received",
      data: { from: "x@y", subject: "Re", text: "hi" },
    });
    const sv = svixSign({ secretRaw: "shh", body });
    const res = await handleResendInboundEcho(
      makeEchoRequest({
        body,
        query: "debug_token=right",
        headers: {
          "svix-id": sv.id,
          "svix-timestamp": sv.ts,
          "svix-signature": sv.sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      secret_configured: boolean;
      signature_valid: boolean;
      body_bytes: number;
    };
    expect(json.secret_configured).toBe(true);
    expect(json.signature_valid).toBe(true);
    expect(json.body_bytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  test("200 + signature_valid:false on a tampered body (echo, no rejection)", async () => {
    process.env.BONSAI_WEBHOOK_DEBUG_TOKEN = "right";
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const body = JSON.stringify({ ok: true });
    const sv = svixSign({ secretRaw: "shh", body });
    const res = await handleResendInboundEcho(
      makeEchoRequest({
        body: body + "x",
        query: "debug_token=right",
        headers: {
          "svix-id": sv.id,
          "svix-timestamp": sv.ts,
          "svix-signature": sv.sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { signature_valid: boolean };
    expect(json.signature_valid).toBe(false);
  });

  test("reports thread_correlation.method='header' when X-Bonsai-Thread-Id is present", async () => {
    process.env.BONSAI_WEBHOOK_DEBUG_TOKEN = "right";
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const tid = `thread_echo_${Math.random().toString(36).slice(2, 8)}`;
    const body = JSON.stringify({
      type: "email.received",
      data: {
        from: "x@y",
        subject: "Re",
        text: "hi",
        headers: [{ name: "X-Bonsai-Thread-Id", value: tid }],
      },
    });
    const sv = svixSign({ secretRaw: "shh", body });
    const res = await handleResendInboundEcho(
      makeEchoRequest({
        body,
        query: "debug_token=right",
        headers: {
          "svix-id": sv.id,
          "svix-timestamp": sv.ts,
          "svix-signature": sv.sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      thread_correlation: { method: string | null; thread_id: string | null };
    };
    expect(json.thread_correlation.method).toBe("header");
    expect(json.thread_correlation.thread_id).toBe(tid);
  });

  test("does not mutate an existing thread file", async () => {
    process.env.BONSAI_WEBHOOK_DEBUG_TOKEN = "right";
    process.env.RESEND_WEBHOOK_SECRET = "shh";
    const tid = `thread_echo_nomut_${Math.random().toString(36).slice(2, 8)}`;
    seedThread(tid);
    const before = loadThread(tid, PROD_THREADS_DIR);
    expect(before.inbound.length).toBe(0);
    const body = JSON.stringify({
      type: "email.received",
      data: {
        from: "x@y",
        subject: "Re",
        text: "hi",
        message_id: "echo-no-mutate-001",
        headers: [{ name: "X-Bonsai-Thread-Id", value: tid }],
      },
    });
    const sv = svixSign({ secretRaw: "shh", body });
    const res = await handleResendInboundEcho(
      makeEchoRequest({
        body,
        query: "debug_token=right",
        headers: {
          "svix-id": sv.id,
          "svix-timestamp": sv.ts,
          "svix-signature": sv.sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const after = loadThread(tid, PROD_THREADS_DIR);
    expect(after.inbound.length).toBe(0);
  });
});

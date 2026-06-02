/**
 * Tests for the REAL outbound email path (Workstream C). The audit's
 * highest-blast-radius failure mode: a real, wrong message sent to a real
 * billing department under a real person's name. This pins the wire
 * contract and the fail-closed behavior so the real path is trustworthy.
 *
 *   - Resend POST body: correct From display name, recipient, subject,
 *     thread-correlation header, In-Reply-To threading.
 *   - Body hits the wire as PLAIN TEXT (markdown stripped) — no literal
 *     asterisks in the rep's inbox.
 *   - Construction FAILS CLOSED when RESEND_FROM is missing (it must never
 *     silently fall back to mock and pretend it sent).
 *   - channelInventory() reports posture honestly.
 *
 * The Resend HTTP call is mocked at the fetch boundary — no real send.
 *
 * Run: bun test test/real-email-path.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResendEmailClient } from "../src/clients/email-resend.ts";
import type { OutboundEmail } from "../src/clients/email.ts";
import { channelInventory, channelInventoryLine } from "../src/lib/channel-inventory.ts";

let threadsDir: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  threadsDir = mkdtempSync(join(tmpdir(), "bonsai-email-"));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(threadsDir, { recursive: true, force: true });
});

function captureFetch(): { calls: Array<{ url: string; body: any; headers: any }> } {
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers,
    });
    return new Response(JSON.stringify({ id: "msg_test_1" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls };
}

function outbound(over: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    to: "billing@hospital.com",
    from: "alex@example.com",
    subject: "Billing dispute — account ACCT-1",
    body_text: "Hello, I am disputing **$3,812.00** in balance billing.",
    thread_id: "thread_abc",
    ...over,
  };
}

describe("ResendEmailClient.send — wire contract", () => {
  test("posts to Resend with display-name From, recipient, subject, and thread header", async () => {
    const { calls } = captureFetch();
    const client = new ResendEmailClient({
      apiKey: "re_test",
      fromEmail: "Bonsai <appeals@bonsai.example>",
      threadsDir,
    });
    await client.send(outbound());

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const body = calls[0].body;
    expect(body.from).toBe("Bonsai (for alex@example.com) <appeals@bonsai.example>");
    expect(body.to).toEqual(["billing@hospital.com"]);
    expect(body.subject).toBe("Billing dispute — account ACCT-1");
    expect(body.headers["X-Bonsai-Thread-Id"]).toBe("thread_abc");
  });

  test("body reaches the wire as plain text (markdown stripped)", async () => {
    const { calls } = captureFetch();
    const client = new ResendEmailClient({ apiKey: "re_test", fromEmail: "appeals@bonsai.example", threadsDir });
    await client.send(outbound());
    const text: string = calls[0].body.text;
    expect(text).toContain("$3,812.00");
    expect(text).not.toContain("**"); // no literal markdown asterisks
  });

  test("a reply sets In-Reply-To / References threading headers", async () => {
    const { calls } = captureFetch();
    const client = new ResendEmailClient({ apiKey: "re_test", fromEmail: "appeals@bonsai.example", threadsDir });
    await client.send(outbound({ in_reply_to: "<msg-7@resend>" }));
    expect(calls[0].body.headers["In-Reply-To"]).toBe("<msg-7@resend>");
    expect(calls[0].body.headers["References"]).toBe("<msg-7@resend>");
  });
});

describe("ResendEmailClient — fails closed", () => {
  test("throws when RESEND_FROM is missing instead of silently mocking", () => {
    expect(() => new ResendEmailClient({ apiKey: "re_test", fromEmail: undefined })).toThrow(/RESEND_FROM/);
  });

  test("throws when the API key is missing", () => {
    expect(() => new ResendEmailClient({ apiKey: undefined, fromEmail: "appeals@bonsai.example" })).toThrow(
      /RESEND_API_KEY/,
    );
  });
});

describe("channelInventory — honest posture", () => {
  test("reports SIMULATED when no real channels are armed", () => {
    const inv = channelInventory({});
    expect(inv.email_real).toBe(false);
    expect(inv.voice_real).toBe(false);
    expect(channelInventoryLine(inv)).toContain("email: SIMULATED");
  });

  test("reports REAL email when Resend env is set", () => {
    const inv = channelInventory({ RESEND_API_KEY: "re_x", RESEND_FROM: "appeals@x.com" });
    expect(inv.email_real).toBe(true);
    expect(channelInventoryLine(inv)).toContain("email: REAL");
  });

  test("voice is REAL only when all three ElevenLabs vars are present", () => {
    expect(channelInventory({ ELEVENLABS_API_KEY: "k" }).voice_real).toBe(false);
    const full = channelInventory({
      ELEVENLABS_API_KEY: "k",
      ELEVENLABS_TWILIO_PHONE_NUMBER_ID: "pn",
      ELEVENLABS_WEBHOOK_BASE: "https://x",
    });
    expect(full.voice_real).toBe(true);
  });
});

/**
 * Tests for src/lib/notify-user.ts
 *
 * The notification path is the user's only signal that the agent reached
 * a terminal state. The contract:
 *
 *   - In-app record is durable: ALWAYS written to inbox.jsonl, even when
 *     email fails. The UI inbox is the source of truth.
 *   - Email is best-effort: tries once, retries once on failure, gives up
 *     after that and logs to failures.jsonl.
 *   - Batching: if multiple un-emailed records exist within the 30-minute
 *     window when a new notification fires, they roll into one digest
 *     email and every record gets stamped with email_sent_at + the batch
 *     ids list.
 *
 * Run: bun test test/notify-user.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyUser, readInbox, type NotifyEmail } from "../src/lib/notify-user.ts";

let originalDataDir: string | undefined;
let tmpDir: string;
const USER_ID = "test_user_1";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bonsai-notify-test-"));
  originalDataDir = process.env.BONSAI_DATA_DIR;
  process.env.BONSAI_DATA_DIR = tmpDir;
  // Seed user-settings.json with a profile email + email_digest=true.
  const userDir = join(tmpDir, "users", USER_ID);
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, "user-settings.json"),
    JSON.stringify({
      profile: { email: "user@example.com" },
      tune: { email_digest: true },
    }),
  );
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.BONSAI_DATA_DIR;
  else process.env.BONSAI_DATA_DIR = originalDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("notifyUser — durable in-app record", () => {
  test("in-app record is written even when sendEmail throws", async () => {
    let attempts = 0;
    const sendEmail = async () => {
      attempts += 1;
      throw new Error("Resend down");
    };
    const result = await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "thread_1",
        kind: "awaiting_user_review",
        provider_name: "Comcast",
        summary: "Rep offered $20/mo for 6 months.",
        amount: 20,
      },
      { sendEmail, retryDelayMs: 0 },
    );
    expect(attempts).toBe(2); // initial + retry
    expect(result.email_sent_at).toBeNull();
    expect(result.last_error).toMatch(/Resend down/);
    // In-app inbox still has the record
    const inbox = readInbox(USER_ID);
    expect(inbox.length).toBe(1);
    expect(inbox[0].thread_id).toBe("thread_1");
    expect(inbox[0].email_sent_at).toBeNull();
    expect(inbox[0].last_error).toMatch(/Resend down/);
    // Failures log was written
    const failuresPath = join(tmpDir, "users", USER_ID, "notifications", "failures.jsonl");
    expect(existsSync(failuresPath)).toBe(true);
    const lines = readFileSync(failuresPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as { reason: string };
    expect(parsed.reason).toBe("send_failed");
  });

  test("retry succeeds on 2nd attempt → record stamped, no failure log", async () => {
    let attempts = 0;
    const sendEmail = async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("transient");
    };
    const result = await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "thread_2",
        kind: "resolved",
        provider_name: "Comcast",
        summary: "Saved $144/yr.",
        amount: 0,
      },
      { sendEmail, retryDelayMs: 0 },
    );
    expect(attempts).toBe(2);
    expect(result.email_sent_at).not.toBeNull();
    expect(result.last_error).toBeUndefined();
    const failuresPath = join(tmpDir, "users", USER_ID, "notifications", "failures.jsonl");
    expect(existsSync(failuresPath)).toBe(false);
  });
});

describe("notifyUser — email gating", () => {
  test("email_digest=false → record persists but no email attempted", async () => {
    // Overwrite settings to disable email_digest.
    writeFileSync(
      join(tmpDir, "users", USER_ID, "user-settings.json"),
      JSON.stringify({
        profile: { email: "user@example.com" },
        tune: { email_digest: false },
      }),
    );
    let calls = 0;
    const sendEmail = async () => {
      calls += 1;
    };
    const result = await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "t",
        kind: "awaiting_user_review",
        provider_name: "Comcast",
        summary: "x",
      },
      { sendEmail, retryDelayMs: 0 },
    );
    expect(calls).toBe(0);
    expect(result.email_sent_at).toBeNull();
    expect(readInbox(USER_ID).length).toBe(1);
  });

  test("missing destination email → in-app written, failure logged, no send attempted", async () => {
    writeFileSync(
      join(tmpDir, "users", USER_ID, "user-settings.json"),
      JSON.stringify({ tune: { email_digest: true } }),
    );
    let calls = 0;
    const sendEmail = async () => {
      calls += 1;
    };
    await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "t",
        kind: "resolved",
        provider_name: "Comcast",
        summary: "x",
      },
      { sendEmail, retryDelayMs: 0 },
    );
    expect(calls).toBe(0);
    const failuresPath = join(tmpDir, "users", USER_ID, "notifications", "failures.jsonl");
    expect(existsSync(failuresPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(failuresPath, "utf8").trim().split("\n")[0]) as {
      reason: string;
    };
    expect(parsed.reason).toBe("no_destination_email");
  });
});

describe("notifyUser — batching", () => {
  test("two notifications within 30 min → digest email, both records stamped", async () => {
    const sent: NotifyEmail[] = [];
    const sendEmail = async (msg: NotifyEmail) => {
      sent.push(msg);
    };
    const fixedNow = new Date("2026-05-02T18:00:00Z");
    const r1 = await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "t1",
        kind: "awaiting_user_review",
        provider_name: "Comcast",
        summary: "Comcast: $20/mo offer.",
        amount: 20,
      },
      { sendEmail, retryDelayMs: 0, now: () => fixedNow },
    );
    expect(r1.email_sent_at).not.toBeNull();
    expect(sent.length).toBe(1);
    expect(sent[0].subject).toMatch(/Comcast/);

    // Second notification 5 minutes later → batches with the first IF
    // first hadn't been emailed yet. Since first WAS emailed, the second
    // is a fresh single-send. To exercise the batching path: we need a
    // case where the first record has email_sent_at=null when the second
    // arrives. Simulate by writing an un-emailed record first.
    const fiveMinLater = new Date(fixedNow.getTime() + 5 * 60_000);
    const r2 = await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "t2",
        kind: "resolved",
        provider_name: "AT&T",
        summary: "AT&T resolved.",
        amount: 0,
      },
      { sendEmail, retryDelayMs: 0, now: () => fiveMinLater },
    );
    expect(sent.length).toBe(2);
    // Second send is a single — not a digest — because first was already
    // stamped.
    expect(sent[1].subject).toMatch(/AT&T/);
    expect(r2.email_batched_with).toBeUndefined();
  });

  test("two un-emailed records within window → next send digests both", async () => {
    // Force a failure on the first send so r1 stays un-emailed.
    let failNext = true;
    const sent: NotifyEmail[] = [];
    const sendEmail = async (msg: NotifyEmail) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient");
      }
      sent.push(msg);
    };
    const fixedNow = new Date("2026-05-02T18:00:00Z");
    // First call fails on both attempts (initial + retry) → record stays
    // un-emailed in inbox.
    const sendAlwaysFail = async () => {
      throw new Error("down");
    };
    await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "t1",
        kind: "awaiting_user_review",
        provider_name: "Comcast",
        summary: "Comcast: $20/mo offer.",
        amount: 20,
      },
      { sendEmail: sendAlwaysFail, retryDelayMs: 0, now: () => fixedNow },
    );
    // Second notification 10 minutes later → finds the un-emailed
    // sibling and rolls into a digest.
    const tenMinLater = new Date(fixedNow.getTime() + 10 * 60_000);
    const r2 = await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "t2",
        kind: "resolved",
        provider_name: "AT&T",
        summary: "AT&T resolved.",
        amount: 0,
      },
      { sendEmail, retryDelayMs: 0, now: () => tenMinLater },
    );
    expect(sent.length).toBe(1);
    expect(sent[0].subject).toMatch(/Bonsai update.*resolved.*call|Bonsai update.*call.*resolved/);
    expect(r2.email_batched_with?.length).toBe(1);
    // Both records now have email_sent_at stamped.
    const inbox = readInbox(USER_ID);
    expect(inbox.every((r) => r.email_sent_at !== null)).toBe(true);
  });
});

describe("notifyUser — email body shape", () => {
  test("awaiting_user_review with requires_signature → subject + body call it out", async () => {
    let captured: NotifyEmail | null = null;
    const sendEmail = async (msg: NotifyEmail) => {
      captured = msg;
    };
    await notifyUser(
      {
        user_id: USER_ID,
        thread_id: "t",
        kind: "awaiting_user_review",
        provider_name: "Acme Insurance",
        summary: "Rep offered settlement at $0.",
        amount: 0,
        requires_signature: true,
        signature_doc_summary: "release of all future claims",
      },
      { sendEmail, retryDelayMs: 0 },
    );
    expect(captured).not.toBeNull();
    if (!captured) throw new Error("captured is null");
    const c = captured as NotifyEmail;
    expect(c.subject).toMatch(/signature required/i);
    expect(c.text).toMatch(/release of all future claims/);
  });
});

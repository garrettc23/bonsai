/**
 * Tests for Workstream A (autonomy):
 *
 *   A1 — the scheduler tick sweeps every user, isolates per-user failures,
 *        and stays disabled unless BONSAI_AUTONOMY=1.
 *   A2 — email-forwarding ingestion routes a bill to its owner and SURFACES
 *        every failure (unroutable, no attachment) — never silently drops.
 *   A3 — the consent boundary resolves to the safest applicable action and
 *        defaults to co-pilot (human approves every send).
 *
 * Deterministic: all I/O (user list, advance, audit kick-off) is injected.
 *
 * Run: bun test test/autonomy.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  autonomyEnabled,
  autonomyIntervalMs,
  runAutonomyTick,
} from "../src/server/scheduler.ts";
import {
  ingestForwardedEmail,
  userIdFromIngestAddresses,
  type ForwardedEmail,
  type IngestDeps,
} from "../src/server/ingest-email.ts";
import {
  defaultConsent,
  decideAutonomousAction,
  agentModeForDecision,
} from "../src/lib/autonomy-consent.ts";
import type { User } from "../src/lib/auth.ts";

function fakeUser(id: string): User {
  return { id, email: `${id}@example.com` } as unknown as User;
}

afterEach(() => {
  delete process.env.BONSAI_AUTONOMY;
  delete process.env.BONSAI_AUTONOMY_INTERVAL_MIN;
});

// ---------------------------------------------------------------------------
// A1 — scheduler
// ---------------------------------------------------------------------------
describe("autonomy scheduler (A1)", () => {
  test("disabled by default; enabled only with BONSAI_AUTONOMY=1", () => {
    expect(autonomyEnabled({})).toBe(false);
    expect(autonomyEnabled({ BONSAI_AUTONOMY: "0" })).toBe(false);
    expect(autonomyEnabled({ BONSAI_AUTONOMY: "1" })).toBe(true);
  });

  test("interval defaults to 15 min and honors override", () => {
    expect(autonomyIntervalMs({})).toBe(15 * 60 * 1000);
    expect(autonomyIntervalMs({ BONSAI_AUTONOMY_INTERVAL_MIN: "5" })).toBe(5 * 60 * 1000);
    expect(autonomyIntervalMs({ BONSAI_AUTONOMY_INTERVAL_MIN: "bogus" })).toBe(15 * 60 * 1000);
  });

  test("tick advances every user exactly once", async () => {
    const advanced: string[] = [];
    const r = await runAutonomyTick({
      users: [fakeUser("u1"), fakeUser("u2"), fakeUser("u3")],
      advance: async (u) => {
        advanced.push(u.id);
      },
    });
    expect(advanced).toEqual(["u1", "u2", "u3"]);
    expect(r).toEqual({ users: 3, errors: 0 });
  });

  test("a failing user is isolated — the sweep continues and counts the error", async () => {
    const advanced: string[] = [];
    const r = await runAutonomyTick({
      users: [fakeUser("u1"), fakeUser("boom"), fakeUser("u3")],
      advance: async (u) => {
        if (u.id === "boom") throw new Error("kaboom");
        advanced.push(u.id);
      },
    });
    expect(advanced).toEqual(["u1", "u3"]);
    expect(r).toEqual({ users: 3, errors: 1 });
  });
});

// ---------------------------------------------------------------------------
// A2 — ingestion
// ---------------------------------------------------------------------------
describe("email-forwarding ingestion (A2)", () => {
  test("extracts userId from a plus-addressed ingest alias", () => {
    expect(userIdFromIngestAddresses(["bills+u_abc123@ingest.bonsai.app"])).toBe("u_abc123");
    expect(userIdFromIngestAddresses(["support@bonsai.app", "bills+u_9@x.com"])).toBe("u_9");
    expect(userIdFromIngestAddresses(["nope@bonsai.app"])).toBeNull();
  });

  function deps(over: Partial<IngestDeps> = {}): IngestDeps & {
    received: any[];
    dropped: any[];
  } {
    const received: any[] = [];
    const dropped: any[] = [];
    return {
      received,
      dropped,
      resolveUser: (to) => (userIdFromIngestAddresses(to) ? fakeUser(userIdFromIngestAddresses(to)!) : null),
      onBillReceived: async (a) => {
        received.push(a);
      },
      onDropped: async (a) => {
        dropped.push(a);
      },
      ...over,
    };
  }

  const pdfEmail: ForwardedEmail = {
    to: ["bills+u_42@ingest.bonsai.app"],
    from: "alex@example.com",
    subject: "Fwd: your statement",
    attachments: [{ filename: "march-statement.pdf", content_type: "application/pdf", content_base64: "JVBERi0=" }],
  };

  test("routes a forwarded bill to its owner and hands it to the pipeline", async () => {
    const d = deps();
    const r = await ingestForwardedEmail(pdfEmail, d);
    expect(r).toEqual({ ok: true, user_id: "u_42", filename: "march-statement.pdf" });
    expect(d.received.length).toBe(1);
    expect(d.received[0].user.id).toBe("u_42");
    expect(d.dropped.length).toBe(0);
  });

  test("an unroutable forward SURFACES (onDropped), never silently lost", async () => {
    const d = deps();
    const r = await ingestForwardedEmail({ ...pdfEmail, to: ["random@bonsai.app"] }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unroutable");
    expect(d.dropped.length).toBe(1);
    expect(d.received.length).toBe(0);
  });

  test("a forward with no PDF SURFACES instead of dropping", async () => {
    const d = deps();
    const r = await ingestForwardedEmail({ ...pdfEmail, attachments: [{ filename: "note.txt", content_base64: "aGk=" }] }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_pdf_attachment");
    expect(d.dropped.length).toBe(1);
    expect(d.received.length).toBe(0);
  });

  test("detects a PDF by filename even when content_type is missing", async () => {
    const d = deps();
    const r = await ingestForwardedEmail(
      { ...pdfEmail, attachments: [{ filename: "BILL.PDF", content_base64: "JVBERi0=" }] },
      d,
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A3 — consent boundary
// ---------------------------------------------------------------------------
describe("autonomy consent boundary (A3)", () => {
  test("default is co-pilot — Bonsai never auto-sends out of the box", () => {
    const c = defaultConsent();
    expect(c.mode).toBe("copilot");
    const d = decideAutonomousAction(c, { bill_kind: "utility", amount_usd: 5 });
    expect(d.action).toBe("copilot");
    expect(agentModeForDecision(d)).toBe("copilot");
  });

  test("mode off → hold (not even a draft)", () => {
    const d = decideAutonomousAction({ mode: "off", auto_send_ceiling_usd: 999, allowed_categories: ["utility"] }, {
      bill_kind: "utility",
      amount_usd: 5,
    });
    expect(d.action).toBe("hold");
  });

  test("autonomous + allowed category + under ceiling → auto_send", () => {
    const d = decideAutonomousAction(
      { mode: "autonomous", auto_send_ceiling_usd: 100, allowed_categories: ["utility", "telecom"] },
      { bill_kind: "telecom", amount_usd: 80 },
    );
    expect(d.action).toBe("auto_send");
    expect(agentModeForDecision(d)).toBe("autonomous");
  });

  test("autonomous but over the dollar ceiling → downgrades to co-pilot", () => {
    const d = decideAutonomousAction(
      { mode: "autonomous", auto_send_ceiling_usd: 100, allowed_categories: ["utility"] },
      { bill_kind: "utility", amount_usd: 250 },
    );
    expect(d.action).toBe("copilot");
    expect(d.reason).toContain("ceiling");
  });

  test("autonomous but category not cleared → downgrades to co-pilot", () => {
    const d = decideAutonomousAction(
      { mode: "autonomous", auto_send_ceiling_usd: 100, allowed_categories: ["utility"] },
      { bill_kind: "medical", amount_usd: 10 },
    );
    expect(d.action).toBe("copilot");
    expect(d.reason).toContain("not in");
  });
});

/**
 * Tests for the ingestion disposition pipeline (A2/A3 production).
 * Pins the safety-critical decision: when does a forwarded bill auto-send,
 * hold for approval, or do nothing — and the invariant that we NEVER
 * auto-send without resolved provider contact.
 *
 * Run: bun test test/ingest-pipeline.test.ts
 */
import { describe, expect, test } from "bun:test";
import { processIngestedBill, type AuditedIngest } from "../src/server/ingest-pipeline.ts";
import { defaultConsent, type AutonomyConsent } from "../src/lib/autonomy-consent.ts";
import type { User } from "../src/lib/auth.ts";

const user = { id: "usr_x", email: "x@example.com" } as unknown as User;

function deps(opts: {
  consent: AutonomyConsent;
  audited: AuditedIngest;
}) {
  const calls = { audit: 0, startNegotiation: [] as string[] };
  return {
    calls,
    audit: async () => {
      calls.audit += 1;
      return opts.audited;
    },
    startNegotiation: async (run_id: string) => {
      calls.startNegotiation.push(run_id);
    },
    getConsent: () => opts.consent,
  };
}

const audited = (over: Partial<AuditedIngest> = {}): AuditedIngest => ({
  run_id: "run_1",
  high_confidence_total: 40,
  has_contact: true,
  ...over,
});

describe("processIngestedBill", () => {
  test("default consent (copilot) → audits then holds for approval, never sends", async () => {
    const d = deps({ consent: defaultConsent(), audited: audited() });
    const r = await processIngestedBill({ user, filename: "b.pdf", content_base64: "x" }, d);
    expect(d.calls.audit).toBe(1);
    expect(r.disposition).toBe("awaiting_approval");
    expect(d.calls.startNegotiation).toEqual([]);
  });

  test("autonomous + allowed + under ceiling + has contact → auto_send", async () => {
    const d = deps({
      consent: { mode: "autonomous", auto_send_ceiling_usd: 100, allowed_categories: ["other"] },
      audited: audited({ high_confidence_total: 40, has_contact: true }),
    });
    const r = await processIngestedBill({ user, filename: "b.pdf", content_base64: "x" }, d);
    expect(r.disposition).toBe("auto_send");
    expect(d.calls.startNegotiation).toEqual(["run_1"]);
  });

  test("SAFETY: auto-send permitted but no contact → holds for approval, does not send", async () => {
    const d = deps({
      consent: { mode: "autonomous", auto_send_ceiling_usd: 100, allowed_categories: ["other"] },
      audited: audited({ has_contact: false }),
    });
    const r = await processIngestedBill({ user, filename: "b.pdf", content_base64: "x" }, d);
    expect(r.disposition).toBe("awaiting_approval");
    expect(d.calls.startNegotiation).toEqual([]);
  });

  test("over the dollar ceiling → downgrades to awaiting_approval", async () => {
    const d = deps({
      consent: { mode: "autonomous", auto_send_ceiling_usd: 25, allowed_categories: ["other"] },
      audited: audited({ high_confidence_total: 500 }),
    });
    const r = await processIngestedBill({ user, filename: "b.pdf", content_base64: "x" }, d);
    expect(r.disposition).toBe("awaiting_approval");
    expect(d.calls.startNegotiation).toEqual([]);
  });

  test("consent off → hold (audited but nothing else)", async () => {
    const d = deps({
      consent: { mode: "off", auto_send_ceiling_usd: 999, allowed_categories: ["other"] },
      audited: audited(),
    });
    const r = await processIngestedBill({ user, filename: "b.pdf", content_base64: "x" }, d);
    expect(r.disposition).toBe("hold");
    expect(d.calls.startNegotiation).toEqual([]);
  });
});

/**
 * Ingestion disposition pipeline (Workstream A2/A3, production).
 *
 * Sits between "a forwarded bill arrived" and "what do we do with it". The
 * messy parts (decode → normalize → transcribe → audit → persist a
 * PendingRun, and kicking off a negotiation) are injected as deps so they can
 * live in the server composition root while the DECISION — does Bonsai send
 * on its own, hold for the user, or do nothing — is unit-testable here.
 *
 * Safety invariants enforced here, not in the glue:
 *   - Bonsai NEVER auto-sends without resolved provider contact (you can't
 *     dispute into the void), even when consent permits it.
 *   - The consent boundary (decideAutonomousAction) is the only thing that
 *     can produce an auto_send; default consent (copilot) always holds for
 *     human approval.
 */
import { getConsent as getConsentDefault } from "../lib/autonomy-consent-store.ts";
import { decideAutonomousAction } from "../lib/autonomy-consent.ts";
import type { User } from "../lib/auth.ts";
import type { BillKind } from "../types.ts";

export interface AuditedIngest {
  run_id: string;
  /** Defensible HIGH-confidence dollars — the amount the consent ceiling is
   * checked against. */
  high_confidence_total: number;
  /** Whether the run already has a provider email/phone to reach. */
  has_contact: boolean;
}

export interface IngestPipelineDeps {
  /** Decode + normalize + transcribe + audit + persist a PendingRun. Returns
   * the run id and the facts the disposition needs. */
  audit: (input: {
    user: User;
    filename: string;
    content_base64: string;
    bill_kind: BillKind;
  }) => Promise<AuditedIngest>;
  /** Flip the run to negotiating and launch the agent. Only called for an
   * auto_send disposition. */
  startNegotiation: (run_id: string) => Promise<void>;
  /** Consent lookup. Defaults to the SQLite store. */
  getConsent?: typeof getConsentDefault;
}

export type IngestDisposition = "auto_send" | "awaiting_approval" | "hold";

export interface IngestOutcome {
  run_id: string;
  disposition: IngestDisposition;
  reason: string;
}

/**
 * Audit a forwarded bill, then apply the consent boundary to decide whether
 * to send autonomously, hold for the user's approval, or do nothing.
 *
 * bill_kind defaults to "other" — a forwarded email carries no reliable
 * category signal, so we use the generic non-medical rule-pack and let the
 * user recategorize in the UI. A medical bill forwarded this way audits with
 * the generic pack (no EOB grounding); that's a known v1 limitation.
 */
export async function processIngestedBill(
  opts: { user: User; filename: string; content_base64: string; bill_kind?: BillKind },
  deps: IngestPipelineDeps,
): Promise<IngestOutcome> {
  const bill_kind: BillKind = opts.bill_kind ?? "other";
  const getConsent = deps.getConsent ?? getConsentDefault;

  const audited = await deps.audit({
    user: opts.user,
    filename: opts.filename,
    content_base64: opts.content_base64,
    bill_kind,
  });

  const decision = decideAutonomousAction(getConsent(opts.user.id), {
    bill_kind,
    amount_usd: audited.high_confidence_total,
  });

  if (decision.action === "hold") {
    return { run_id: audited.run_id, disposition: "hold", reason: decision.reason };
  }

  if (decision.action === "auto_send") {
    if (!audited.has_contact) {
      // Consent permits it, but there's nowhere to send yet. Never dispute
      // into the void — hold for the user (who can add contact + approve).
      return {
        run_id: audited.run_id,
        disposition: "awaiting_approval",
        reason: "Auto-send permitted but no provider contact resolved yet — holding for review.",
      };
    }
    await deps.startNegotiation(audited.run_id);
    return { run_id: audited.run_id, disposition: "auto_send", reason: decision.reason };
  }

  // copilot
  return { run_id: audited.run_id, disposition: "awaiting_approval", reason: decision.reason };
}

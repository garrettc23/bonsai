/**
 * Autonomy consent boundary (Workstream A3).
 *
 * When Bonsai acts WITHOUT a human in the loop (a bill arrives via ingestion,
 * the scheduler kicks off a negotiation), this policy decides whether it may
 * actually send on the customer's behalf or must stop and ask first.
 *
 * SAFE BY DEFAULT: the default policy is "copilot" — Bonsai drafts, the human
 * approves every send. Fully autonomous sending is opt-in, scoped to specific
 * bill categories, and capped by a dollar ceiling. The principle: the cost of
 * Bonsai being wrong (a bad dispute sent under the user's name) must stay low
 * and reversible, so we only let it act alone where the user explicitly said
 * so and the stakes are bounded.
 *
 * Pure policy — no I/O — so the boundary is trivially testable and can be
 * reasoned about in isolation.
 */
import type { BillKind } from "../types.ts";

export type AutonomyMode = "off" | "copilot" | "autonomous";

export interface AutonomyConsent {
  /**
   * off        — no autonomy at all; nothing happens without a human action.
   * copilot    — Bonsai drafts and waits; the human approves every send.
   * autonomous — Bonsai may send on its own, within the limits below.
   */
  mode: AutonomyMode;
  /** Max disputed dollars an autonomous action may act on without approval.
   * Anything above this is downgraded to copilot (human approves). */
  auto_send_ceiling_usd: number;
  /** Bill categories the user has cleared for autonomous action. A kind not
   * in this list is always copilot, even in autonomous mode. */
  allowed_categories: BillKind[];
}

/** The safe default every account starts on: draft, never auto-send. */
export function defaultConsent(): AutonomyConsent {
  return { mode: "copilot", auto_send_ceiling_usd: 0, allowed_categories: [] };
}

export type ConsentDecision =
  /** Bonsai may send on its own. */
  | { action: "auto_send"; reason: string }
  /** Bonsai may draft but must wait for the human to approve the send. */
  | { action: "copilot"; reason: string }
  /** Bonsai does nothing — autonomy is off entirely. */
  | { action: "hold"; reason: string };

/**
 * The one decision point: given the user's consent policy and a concrete
 * proposed action (bill kind + dollars at stake), what is Bonsai allowed to
 * do? Always resolves to the SAFEST applicable action.
 */
export function decideAutonomousAction(
  consent: AutonomyConsent,
  action: { bill_kind: BillKind; amount_usd: number },
): ConsentDecision {
  if (consent.mode === "off") {
    return { action: "hold", reason: "Autonomy is off — no action without the user." };
  }
  if (consent.mode === "copilot") {
    return { action: "copilot", reason: "Co-pilot mode — Bonsai drafts, the user approves every send." };
  }
  // autonomous mode — apply the guardrails.
  if (!consent.allowed_categories.includes(action.bill_kind)) {
    return {
      action: "copilot",
      reason: `${action.bill_kind} is not in the user's autonomous-allowed categories — downgraded to co-pilot.`,
    };
  }
  if (action.amount_usd > consent.auto_send_ceiling_usd) {
    return {
      action: "copilot",
      reason: `$${action.amount_usd.toFixed(2)} exceeds the auto-send ceiling of $${consent.auto_send_ceiling_usd.toFixed(2)} — downgraded to co-pilot.`,
    };
  }
  return {
    action: "auto_send",
    reason: `Within consent: ${action.bill_kind} ≤ $${consent.auto_send_ceiling_usd.toFixed(2)} ceiling.`,
  };
}

/**
 * Map a consent decision to the negotiator's agent_mode. auto_send →
 * "autonomous" (the agent sends); copilot/hold → "copilot" (drafts, waits).
 * Callers handle "hold" separately when they must not even draft.
 */
export function agentModeForDecision(decision: ConsentDecision): "autonomous" | "copilot" {
  return decision.action === "auto_send" ? "autonomous" : "copilot";
}

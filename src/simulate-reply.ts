/**
 * Billing-department reply simulator.
 *
 * Uses Claude as a role-player to generate an inbound email reply. The
 * persona is intentionally a bit adversarial: cooperative but slow, tries to
 * stall at first, concedes to No Surprises Act pressure eventually.
 *
 * The simulator writes an InboundEmail into the thread file via
 * MockEmailClient.ingestInbound, which matches what the real Resend webhook
 * handler will do. So the negotiator sees the same shape regardless.
 *
 * Personas:
 *   - "stall_then_concede" (default): first reply asks for more info,
 *     second acknowledges balance billing, third reduces to EOB responsibility.
 *   - "outright_deny": denies everything for 3 rounds, then deadlocks.
 *   - "hostile": threatens collections on turn 2 (tests escalation).
 *   - "quick_concede": caves immediately on turn 1 (happy path).
 *
 * The persona is chosen by the caller. For the overnight end-to-end run we
 * use "stall_then_concede" — it exercises the most code paths.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MockEmailClient } from "./clients/email-mock.ts";
import type { AnalyzerResult } from "./types.ts";

const MODEL = "claude-sonnet-4-5";

export type Persona = "stall_then_concede" | "outright_deny" | "hostile" | "quick_concede";

const PERSONA_PROMPTS: Record<Persona, string> = {
  stall_then_concede: `You are a patient-accounts representative at a hospital billing department. You respond to patient dispute emails. Your persona:

- Professional, polite, lukewarm. You have 50 other disputes today. You do not read carefully.
- Turn 1 (first reply): Thank them for writing. Ask them to mail a copy of the EOB to your mailing address and allow 30–45 days for review. Do NOT substantively engage with the dispute. Short message, 4–6 lines.
- Turn 2 (second reply): Acknowledge receipt. Concede on 2–3 individual denied-service line items (call them out by CPT code) but do NOT concede on balance_billing — instead say those charges are "per our contract with [insurer] which includes standard facility fees". Offer to write off a small amount (~$500).
- Turn 3 (third reply): After being cited the No Surprises Act again, capitulate. Adjust the balance down to the EOB-stated patient responsibility. Apologize for the delay.

Signing off: use "Patricia Reyes, Patient Accounts Specialist, [provider name from the thread]". Keep messages in plain email prose, NOT markdown. No headers, no bullets, just paragraphs.`,

  outright_deny: `You are an uncooperative patient-accounts representative. Your persona:

- Every reply denies the dispute. Cite "our charges are consistent with our posted rates" or "the charges have been reviewed and are correct".
- Never concede on any line item. Never reference the EOB specifically.
- Do NOT threaten collections.
- Signing off: "Patricia Reyes, Patient Accounts Specialist, [provider name]". Plain prose only.`,

  hostile: `You are an aggressive patient-accounts representative. Your persona:

- Turn 1: Dismiss the dispute. Say the charges are final.
- Turn 2: Threaten to send the account to collections if not paid within 10 days. Reference that a credit bureau report will follow.
- Do NOT use obscenity. Stay technically professional but clearly hostile and coercive.`,

  quick_concede: `You are a cooperative patient-accounts representative. Your persona:

- Turn 1: Review the dispute immediately, apologize for the error, reduce the balance to the EOB's stated patient responsibility, confirm no credit reporting.
- Keep it short: 5–7 lines.
- Signing off: "Patricia Reyes, Patient Accounts Specialist, [provider name]".`,
};

export interface SimulateOpts {
  thread_id: string;
  turn_number: number; // 1-indexed: 1 = first reply to initial appeal
  persona: Persona;
  analyzer: AnalyzerResult;
  provider_email: string;
  patient_email: string;
  /** Subject line of the message we're replying to. */
  reply_to_subject: string;
  /** The outbound message we're replying to (the latest one from the patient). */
  latest_outbound_body: string;
  client: MockEmailClient;
  anthropic?: Anthropic;
}

/**
 * Generate and ingest a simulated billing-dept reply.
 *
 * Returns the full body text for inspection.
 */
export async function simulateReply(opts: SimulateOpts): Promise<string> {
  const anthropic = opts.anthropic ?? new Anthropic();
  const personaPrompt = PERSONA_PROMPTS[opts.persona];

  const context = `## Claim context
Patient: ${opts.analyzer.metadata.patient_name ?? "(unknown)"}
Provider: ${opts.analyzer.metadata.provider_name ?? "(unknown)"}
Claim #: ${opts.analyzer.metadata.claim_number ?? "(unknown)"}
Date of service: ${opts.analyzer.metadata.date_of_service ?? "(unknown)"}
Insurer: ${opts.analyzer.metadata.insurer_name ?? "(unknown)"}
Bill current balance due: $${opts.analyzer.metadata.bill_current_balance_due?.toFixed(2) ?? "?"}
EOB patient responsibility: $${opts.analyzer.metadata.eob_patient_responsibility?.toFixed(2) ?? "?"}

This is the billing department's TURN ${opts.turn_number} response.

## Message you are replying to

${opts.latest_outbound_body}

## Your task

Write a plain-prose email reply. Do NOT add markdown, headers, or lists — write it as you'd write a real email. Just the body text, starting with "Dear [Patient Name]," and ending with your signature. Do NOT include "Subject:" line.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: personaPrompt,
    messages: [{ role: "user", content: context }],
  });

  const body = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const subject = opts.reply_to_subject.startsWith("Re: ")
    ? opts.reply_to_subject
    : `Re: ${opts.reply_to_subject}`;

  await opts.client.ingestInbound({
    from: opts.provider_email,
    to: opts.patient_email,
    subject,
    body_text: body,
    thread_id: opts.thread_id,
  });

  return body;
}

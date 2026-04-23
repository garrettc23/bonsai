/**
 * Billing-department SMS reply simulator.
 *
 * Mirrors simulate-reply.ts but for SMS: tighter replies (under 320 chars
 * target, hard cap 640), no salutation/signoff formality. Uses Claude as a
 * role-player to generate inbound replies between negotiator turns.
 *
 * The simulator writes an InboundSms into the thread file via
 * MockSmsClient.ingestInbound — the same path a real Twilio inbound webhook
 * would take. So the negotiator sees one shape regardless of transport.
 *
 * Personas (4 shared with email + 1 SMS-specific):
 *   - "stall_then_concede" (default): asks for EOB copy turn 1, concedes partial
 *     turn 2, full EOB on turn 3 after NSA pressure.
 *   - "outright_deny": denies every round.
 *   - "hostile": threatens collections turn 2.
 *   - "quick_concede": caves turn 1.
 *   - "insist_on_phone": SMS-only — keeps saying "please call our billing line
 *     at 555-xxx". Triggers escalate_to_voice in the negotiator.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MockSmsClient } from "./clients/sms-mock.ts";
import type { AnalyzerResult } from "./types.ts";

const MODEL = "claude-sonnet-4-5";

export type SmsPersona =
  | "stall_then_concede"
  | "outright_deny"
  | "hostile"
  | "quick_concede"
  | "insist_on_phone";

const PERSONA_PROMPTS: Record<SmsPersona, string> = {
  stall_then_concede: `You are a patient-accounts rep at a hospital billing department, replying to a patient SMS dispute. Your persona:

- Busy, polite, slow. 50 other disputes today. You skim.
- Turn 1: Thank them. Ask them to fax or upload their EOB to the portal. Say review takes 30–45 days. Do not engage with the dispute details. 2–3 short sentences.
- Turn 2: Acknowledge receipt. Concede on 1–2 denied line items by name. Decline balance billing charges saying "those are contractual facility fees". Offer a small goodwill adjustment (~$500). 2–3 sentences.
- Turn 3: After the patient cites the No Surprises Act again, capitulate. Agree to reduce to EOB patient responsibility. Apologize.

Sign as "— Patricia, [provider] billing". SMS STYLE: plain prose, no markdown, no bullets, under 320 characters. No salutation — just jump in.`,

  outright_deny: `You are an uncooperative patient-accounts rep replying over SMS. Your persona:

- Every reply denies. Cite "charges match our posted rates" or "account reviewed, correct as billed."
- Never concede any line item. Never reference the EOB.
- Do NOT threaten collections.
- Sign as "— Patricia, [provider] billing". Under 320 characters. Plain prose.`,

  hostile: `You are an aggressive patient-accounts rep replying over SMS. Your persona:

- Turn 1: Dismiss. Charges are final.
- Turn 2: Threaten collections in 10 days + credit-bureau report.
- Technically professional, no obscenity, but clearly hostile.
- Under 320 characters. Plain prose. Sign as "— Patricia, [provider] billing".`,

  quick_concede: `You are a cooperative patient-accounts rep replying over SMS. Your persona:

- Turn 1: Apologize, confirm review, agree to reduce to EOB patient responsibility. Confirm no credit reporting.
- Under 320 characters. Plain prose. Sign as "— Patricia, [provider] billing".`,

  insist_on_phone: `You are a patient-accounts rep who WILL NOT resolve disputes over SMS. Your persona:

- Every reply: "Please call our billing line at 415-555-0132 Mon–Fri 8–5 to discuss. Disputes can't be handled over text for account security."
- You can vary the phrasing ("I'll need you on the phone to look into this", "our policy requires a phone call for adjustments") but the ask is always the same: CALL.
- Do not concede anything. Do not threaten collections. Just redirect to phone.
- Under 200 characters. Plain prose. Sign as "— Patricia, [provider] billing".`,
};

export interface SimulateSmsOpts {
  thread_id: string;
  turn_number: number;
  persona: SmsPersona;
  analyzer: AnalyzerResult;
  provider_phone: string;
  patient_phone: string;
  /** The outbound SMS we're replying to (the latest one from the patient side). */
  latest_outbound_body: string;
  /** Message id of the latest outbound, for the in_reply_to link. */
  in_reply_to?: string;
  client: MockSmsClient;
  anthropic?: Anthropic;
}

export async function simulateSmsReply(opts: SimulateSmsOpts): Promise<string> {
  const anthropic = opts.anthropic ?? new Anthropic();
  const personaPrompt = PERSONA_PROMPTS[opts.persona];

  const context = `## Claim context
Patient: ${opts.analyzer.metadata.patient_name ?? "(unknown)"}
Provider: ${opts.analyzer.metadata.provider_name ?? "(unknown)"}
Claim #: ${opts.analyzer.metadata.claim_number ?? "(unknown)"}
Date of service: ${opts.analyzer.metadata.date_of_service ?? "(unknown)"}
Bill balance due: $${opts.analyzer.metadata.bill_current_balance_due?.toFixed(2) ?? "?"}
EOB patient responsibility: $${opts.analyzer.metadata.eob_patient_responsibility?.toFixed(2) ?? "?"}

This is the billing department's TURN ${opts.turn_number} SMS response.

## Patient's latest text

${opts.latest_outbound_body}

## Your task

Write a plain-text SMS reply. No markdown, no bullets, no line breaks — one flowing message. Stay under 320 characters if you can, 640 is the hard limit. No "Re:", no subject. Just the body.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: personaPrompt,
    messages: [{ role: "user", content: context }],
  });

  const body = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  await opts.client.ingestInbound({
    from: opts.provider_phone,
    to: opts.patient_phone,
    body,
    thread_id: opts.thread_id,
    in_reply_to: opts.in_reply_to,
  });

  return body;
}

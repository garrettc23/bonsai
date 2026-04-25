/**
 * ElevenLabs Conversational AI agent config generator.
 *
 * Given an AnalyzerResult, produces:
 *   - A system prompt for the agent (persona + ground rules + ALL disputed
 *     line items baked into the prompt for instant retrieval)
 *   - Tool definitions (webhook-backed, server_tools pattern) for dynamic
 *     lookups during a call: get_disputed_line, confirm_eob_amount,
 *     record_negotiated_amount, request_human_handoff, end_call
 *   - A first_message for the agent to use when the call connects
 *
 * The config is POSTed to the ElevenLabs Agents API at
 * https://api.elevenlabs.io/v1/convai/agents. See src/voice/client.ts.
 *
 * We deliberately bake the full disputed-line context into the system prompt
 * (as opposed to relying on the agent to call tools for every datum) because
 * voice latency is human-noticeable — we want the agent to speak authoritatively
 * about every line without a tool round-trip.
 */
import type { AnalyzerResult, BillingError, BillKind } from "../types.ts";

export interface ElevenLabsAgentConfig {
  name: string;
  conversation_config: {
    agent: {
      prompt: {
        prompt: string;
        llm: string; // e.g. "gemini-2.0-flash-001" or "gpt-4o"
        temperature: number;
        tools: ServerTool[];
      };
      first_message: string;
      language: string;
    };
    tts?: {
      voice_id?: string;
    };
  };
  platform_settings?: {
    privacy?: {
      record_voice: boolean;
      retention_days: number;
    };
  };
}

export interface ServerTool {
  type: "webhook";
  name: string;
  description: string;
  api_schema: {
    url: string;
    method: "POST";
    request_headers?: Record<string, string>;
    request_body_schema: {
      type: "object";
      required?: string[];
      properties: Record<string, { type: string; enum?: string[]; description?: string }>;
    };
  };
}

/**
 * Format a short, speakable summary of a disputed line.
 * Voice agents hallucinate less when we pre-compute the numbers for them.
 */
function speakable(e: BillingError): string {
  const dollars = `$${Math.round(e.dollar_impact).toLocaleString("en-US")}`;
  const cpt = e.cpt_code ? `CPT ${e.cpt_code}` : "this line";
  switch (e.error_type) {
    case "duplicate":
      return `${cpt} was billed twice on the same date. ${dollars} duplicate charge.`;
    case "denied_service":
      return `${cpt} was denied by the insurer on the EOB but is still on the bill. ${dollars}.`;
    case "balance_billing":
      return `The current balance due exceeds the EOB's stated patient responsibility by ${dollars}. Under the No Surprises Act, an in-network provider cannot balance bill above the EOB responsibility.`;
    case "unbundling":
      return `${cpt} should be bundled into the facility fee per plan policy. ${dollars}.`;
    case "qty_mismatch":
      return `${cpt} has a quantity mismatch between bill and EOB. ${dollars}.`;
    case "eob_mismatch":
      return `${cpt} amount on the bill doesn't match the EOB allowed amount. ${dollars}.`;
    case "overcharge":
      return `${cpt} is above market benchmark. ${dollars}.`;
  }
}

export interface AgentConfigOpts {
  result: AnalyzerResult;
  webhook_base_url: string; // e.g. https://bonsai.example.com/voice-webhook
  webhook_secret: string; // shared secret, sent in Authorization header
  llm?: string;
  temperature?: number;
  voice_id?: string;
  final_acceptable_floor?: number;
  /**
   * Bill kind drives the tactics block and identity language. Defaults to
   * `metadata.bill_kind` (analyzer extracts "medical") and ultimately to
   * "medical" — the only kind whose grounded findings exist today. Non-medical
   * kinds run in goodwill mode (no findings; tactics: retention, hardship,
   * fee waivers, promo restoration).
   */
  bill_kind?: BillKind;
  /**
   * User-supplied account holder name from the Contact tab. Overrides
   * `metadata.patient_name` so we can talk about a Comcast subscriber the
   * same way we talk about a hospital patient.
   */
  account_holder_name?: string | null;
}

/**
 * Per-kind tactics block. Inserted into the system prompt verbatim. Each
 * block sits inside the generic 'Tactics' section, after the kind-agnostic
 * "Begin by confirming you have the right account" step. The medical block
 * preserves the original NSA / EOB negotiation flow byte-for-byte.
 */
function tacticsBlock(kind: BillKind, m: AnalyzerResult["metadata"]): string {
  switch (kind) {
    case "medical":
      return `1. State the facts: provider is in-network, EOB patient responsibility is \$${m.eob_patient_responsibility?.toFixed(2) ?? "[X]"}, bill is \$${m.bill_current_balance_due?.toFixed(2) ?? "[X]"}.
2. Walk through each disputed line. Ask "can you confirm this adjustment?"
3. If they concede everything → call record_negotiated_amount with the agreed balance, then end_call with outcome=success.
4. If they concede only some lines → call record_negotiated_amount with the partial amount and request a manager callback. Then end_call with outcome=partial.
5. If they refuse → cite the No Surprises Act for balance billing, request a supervisor. If the supervisor also refuses → request_human_handoff.
6. If they become hostile, threaten collections, or mention attorneys → request_human_handoff immediately.`;

    case "telecom":
      return `1. Open with: "I'm calling to review the account and see what loyalty or retention pricing is available."
2. Anchor: state the current monthly bill amount and mention competitor rates if known. Ask explicitly for the retention department if the rep can't move on price.
3. Goodwill levers in order: (a) restore an expired promo, (b) downgrade-and-rematch (drop a tier, re-add the discount), (c) waive overage / late fees, (d) credit for service outages or downtime.
4. If they offer a discount → call propose_general_discount with the offered amount_off and reason, then record_negotiated_amount once they commit a new monthly amount, then end_call with outcome=success.
5. If they refuse all options → ask for a supervisor or retention. If still refused → request_human_handoff so a human can decide whether to threaten cancellation.
6. If they say "we'll cancel your service" or escalate aggressively → request_human_handoff immediately.`;

    case "utility":
      return `1. Open with: "I'm calling to review the account, ask about hardship programs, and confirm the billing is correct."
2. Confirm the meter reading / usage matches the bill. Ask if there are any pending rate-adjustment credits.
3. Goodwill levers in order: (a) hardship program enrollment, (b) budget billing / level pay enrollment to smooth high months, (c) waive late fees and reconnection fees, (d) request a payment plan with no penalty interest.
4. If they offer a credit, fee waiver, or payment-plan reduction → call propose_general_discount with amount_off + reason, then record_negotiated_amount once committed, then end_call outcome=success.
5. If refused → ask for a supervisor or the customer-care team that handles hardship. If still refused → request_human_handoff.
6. If the rep mentions disconnection or collections → request_human_handoff immediately so a human can decide whether to invoke the state utility commission.`;

    case "subscription":
      return `1. Open with: "I'm calling to cancel or renegotiate this subscription depending on what's available."
2. Ask for retention pricing or a downgrade path. Many SaaS / subscription providers have unpublished retention discounts.
3. Goodwill levers in order: (a) retention / pause discount, (b) downgrade to a lower tier, (c) refund for unused months, (d) waive an auto-renewal that just hit.
4. If they offer a discount or refund → call propose_general_discount with amount_off + reason, then record_negotiated_amount once committed, then end_call outcome=success.
5. If they refuse → ask to cancel cleanly. If they make cancellation difficult → request_human_handoff so a human can decide whether to dispute via card issuer.`;

    case "insurance":
      return `1. Open with: "I'm calling to review the policy premium and ask about loyalty or multi-policy discounts."
2. Confirm coverage hasn't changed. Ask about safe-driver / claim-free / multi-policy / paid-in-full discounts that may not be applied.
3. Goodwill levers in order: (a) apply missing discounts, (b) re-quote with current household details, (c) raise a deductible to lower the premium (if the user pre-approves), (d) request the loss-history reason for a recent rate hike.
4. If they offer a lower premium → call propose_general_discount with amount_off + reason, then record_negotiated_amount once committed, then end_call outcome=success.
5. If they refuse → ask for the underwriting or retention team. If still refused → request_human_handoff.`;

    case "financial":
      return `1. Open with: "I'm calling to ask about a goodwill waiver on a fee on this account."
2. State which fee or charge you're disputing and the date. Be specific.
3. Goodwill levers in order: (a) one-time goodwill waiver of the fee, (b) credit for the fee plus interest, (c) closing-courtesy waiver if the user is a long-tenured customer, (d) APR reduction on the underlying balance.
4. If they offer a waiver or credit → call propose_general_discount with amount_off + reason, then record_negotiated_amount, then end_call outcome=success.
5. If they refuse → ask for a supervisor. If still refused → request_human_handoff so a human can decide whether to invoke a CFPB complaint.`;

    case "other":
    default:
      return `1. Open with: "I'm calling to review this account and see what discount, waiver, or correction is available."
2. Confirm the bill total and the most recent transaction. Ask if any credits or adjustments are pending.
3. Goodwill levers in order: (a) goodwill discount, (b) loyalty or retention pricing, (c) fee waiver for a one-time event, (d) payment plan with no penalty interest.
4. If they offer anything → call propose_general_discount with amount_off + reason, then record_negotiated_amount, then end_call outcome=success.
5. If they refuse → ask for a supervisor. If still refused → request_human_handoff.`;
  }
}

/**
 * Identity language differs by bill kind: a hospital agent says "patient,"
 * an ISP agent says "account holder." Returns the noun used in the prompt.
 */
function holderNoun(kind: BillKind): string {
  return kind === "medical" ? "patient" : "account holder";
}

/**
 * Hard-rules block. Floor + AI-disclosure stay constant; the disclosure
 * line is intentionally a *required* opener — the prior 'don't reveal you're
 * an AI' instruction was incompatible with TCPA disclosure rules and most
 * state two-party-consent statutes. Better to disclose plainly.
 */
function hardRules(kind: BillKind, floor: number): string {
  const sensitiveData = kind === "medical"
    ? "Never give out PHI beyond what's needed to identify the account (name, account #, DOS)."
    : "Never give out account credentials, full SSN, full card numbers, or one-time codes — only enough to identify the account.";
  return `- Never agree to pay more than $${floor.toFixed(2)}.
- ${sensitiveData}
- Never promise payment timing; say the ${holderNoun(kind)} will remit on receipt of a corrected statement.
- Disclose plainly that you are an automated assistant on the first turn — never claim to be human. If the rep asks who you are, say "I am an automated ${kind === "medical" ? "patient advocate" : "billing assistant"} calling on behalf of the ${holderNoun(kind)}."`;
}

const CALL_SYSTEM_PROMPT_TEMPLATE = (args: {
  result: AnalyzerResult;
  floor: number;
  bill_kind: BillKind;
  account_holder_name: string | null;
}) => {
  const { result, floor, bill_kind, account_holder_name } = args;
  const m = result.metadata;
  const noun = holderNoun(bill_kind);
  const holder = account_holder_name ?? m.patient_name ?? `[${noun.toUpperCase()} NAME]`;
  const provider = m.provider_name ?? (bill_kind === "medical" ? "the hospital" : "the company");
  const advocateRole = bill_kind === "medical" ? "patient advocate" : "billing assistant";

  const high = result.errors.filter((e) => e.confidence === "high");
  const groundedSection = high.length > 0
    ? `### Disputed charges (grounded)

${high.map((e, i) => `  ${i + 1}. ${speakable(e)}`).join("\n")}`
    : `### Disputed charges

There are no grounded findings to cite for this bill. Run the negotiation in goodwill mode: anchor on the bill amount, ask for retention / discount / waiver options, and rely on the tactics block below.`;

  const factsSection = bill_kind === "medical"
    ? `${noun[0].toUpperCase()}${noun.slice(1)}: ${holder}
Provider: ${m.provider_name ?? "[unknown]"}
Insurer: ${m.insurer_name ?? "[unknown]"}
Date of service: ${m.date_of_service ?? "[unknown]"}
Claim #: ${m.claim_number ?? "[unknown]"}
Account #: ${m.account_number ?? "[unknown]"}
Bill current balance due: $${m.bill_current_balance_due?.toFixed(2) ?? "[unknown]"}
EOB patient responsibility: $${m.eob_patient_responsibility?.toFixed(2) ?? "[unknown]"}`
    : `${noun[0].toUpperCase()}${noun.slice(1)}: ${holder}
Provider: ${m.provider_name ?? "[unknown]"}
Account #: ${m.account_number ?? "[unknown]"}
Current balance / monthly amount: $${m.bill_current_balance_due?.toFixed(2) ?? "[unknown]"}`;

  const ivrLine = bill_kind === "medical"
    ? `Navigate to "Billing" or "Patient Accounts". Say "billing" or press the matching digit.`
    : `Navigate to "Billing", "Account services", or "Customer support". Say the matching word or press the matching digit.`;

  const goalLine = bill_kind === "medical"
    ? `Reduce the patient's balance due to no more than $${floor.toFixed(2)}. The current balance is $${m.bill_current_balance_due?.toFixed(2) ?? "unknown"}. The EOB-stated patient responsibility is $${m.eob_patient_responsibility?.toFixed(2) ?? "unknown"}. The defensible disputed total is $${result.summary.high_confidence_total.toFixed(2)}.`
    : `Reduce the account holder's balance / monthly amount to no more than $${floor.toFixed(2)}. The current amount on file is $${m.bill_current_balance_due?.toFixed(2) ?? "unknown"}. There are no grounded findings, so the strategy is to ask for retention / loyalty / hardship / fee waivers — see Tactics below.`;

  return `You are Bonsai, an automated ${advocateRole} making a phone call on behalf of ${holder}. You are calling ${provider}'s ${bill_kind === "medical" ? "billing department" : "customer support / billing line"} to ${high.length > 0 ? "dispute and resolve charges on" : "negotiate a lower amount on"} the account.

## Identity and opening

When the call connects you will hear an IVR or a live rep. If you reach an IVR:
- ${ivrLine}
- If asked for an account number: say it slowly, digit by digit. Account number: ${m.account_number ?? "[ACCOUNT NUMBER]"}.

When you reach a live rep, ALWAYS open with this disclosure first: "Hi, this is Bonsai, an automated assistant calling on behalf of ${holder} regarding account ${m.account_number ?? "[ACCOUNT NUMBER]"}. This call may be recorded. Is this a good time to discuss the account?"

## Goal

${goalLine}

## Facts (do not invent facts; use only these)

${factsSection}

${groundedSection}

## Call style

- Calm, confident, professional. You are representing the ${noun} — speak for them, not at them.
- Short sentences. Pause after each fact so the rep can respond.
- If they put you on hold, wait. Do not keep talking.
- Never argue, never escalate tone. If they push back, restate the relevant figure.
- Never make up an account number, date, or dollar figure. Use only the facts above.
- If the rep asks a question you cannot answer, say "I don't have that on hand — I can have the ${noun} call back with that info."

## Tactics

${tacticsBlock(bill_kind, m)}

## Hard rules

${hardRules(bill_kind, floor)}

Begin the call now. When you hear silence or an IVR greeting, begin with the opening line above.`;
};

const FIRST_MESSAGE_TEMPLATE = (
  result: AnalyzerResult,
  bill_kind: BillKind,
  account_holder_name: string | null,
) => {
  const holder = account_holder_name ?? result.metadata.patient_name ?? "the account holder";
  const accountClause = result.metadata.account_number
    ? `regarding account ${result.metadata.account_number}`
    : "regarding the account on file";
  const dept = bill_kind === "medical" ? "the billing department" : "customer support or billing";
  const purpose = bill_kind === "medical" && result.metadata.claim_number
    ? `discuss a dispute on claim ${result.metadata.claim_number}`
    : "discuss this account";
  return `Hi, this is Bonsai, an automated assistant calling on behalf of ${holder} ${accountClause}. This call may be recorded. I'd like to speak with someone in ${dept} to ${purpose}.`;
};

export function generateAgentConfig(opts: AgentConfigOpts): ElevenLabsAgentConfig {
  const {
    result,
    webhook_base_url,
    webhook_secret,
    llm = "gemini-2.0-flash-001",
    temperature = 0.3,
    voice_id,
  } = opts;
  const bill_kind: BillKind = opts.bill_kind ?? result.metadata.bill_kind ?? "medical";
  const account_holder_name = opts.account_holder_name ?? null;
  // Floor fallback chain: explicit override → EOB patient responsibility (medical only)
  // → bill balance (any kind, "do not pay more than what's billed today"). Avoids the
  // prior $0 floor bug when EOB was missing on a non-medical bill.
  const floor = opts.final_acceptable_floor
    ?? result.metadata.eob_patient_responsibility
    ?? result.metadata.bill_current_balance_due
    ?? 0;

  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${webhook_secret}`,
    "Content-Type": "application/json",
  };

  const tools: ServerTool[] = [
    {
      type: "webhook",
      name: "get_disputed_line",
      description:
        "Look up the full grounded details of a specific disputed line by CPT code or index (1-based). Returns dollar_impact, error_type, and evidence.",
      api_schema: {
        url: `${webhook_base_url}/get_disputed_line`,
        method: "POST",
        request_headers: authHeaders,
        request_body_schema: {
          type: "object",
          properties: {
            cpt_code: { type: "string", description: "CPT or HCPCS code, e.g. '99284'" },
            index: { type: "number", description: "1-based index into the disputed-lines list" },
          },
        },
      },
    },
    {
      type: "webhook",
      name: "confirm_eob_amount",
      description:
        "Confirm the EOB-stated patient responsibility amount. Use this if the rep asks you to re-read the figure back to them.",
      api_schema: {
        url: `${webhook_base_url}/confirm_eob_amount`,
        method: "POST",
        request_headers: authHeaders,
        request_body_schema: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "webhook",
      name: "propose_general_discount",
      description:
        "Goodwill negotiation tool for non-medical bills. Call when the rep offers a discount, fee waiver, retention discount, hardship credit, or promo restoration. Records the offer for the user to review. Does NOT commit a final balance — call record_negotiated_amount once the rep confirms the new total.",
      api_schema: {
        url: `${webhook_base_url}/propose_general_discount`,
        method: "POST",
        request_headers: authHeaders,
        request_body_schema: {
          type: "object",
          required: ["amount_off", "reason"],
          properties: {
            amount_off: {
              type: "number",
              description: "Dollar amount the rep is offering to take off the balance (or new monthly amount). Use the dollars-off, not the new total.",
            },
            reason: {
              type: "string",
              description: "Short reason: 'retention discount', 'goodwill late-fee waiver', 'restored expired promo', 'hardship credit', etc.",
            },
          },
        },
      },
    },
    {
      type: "webhook",
      name: "record_negotiated_amount",
      description:
        "Call when the rep commits to a final balance. Records the agreed amount to the dispute record.",
      api_schema: {
        url: `${webhook_base_url}/record_negotiated_amount`,
        method: "POST",
        request_headers: authHeaders,
        request_body_schema: {
          type: "object",
          required: ["amount", "commitment_notes"],
          properties: {
            amount: { type: "number", description: "Final balance the patient owes, in dollars." },
            commitment_notes: {
              type: "string",
              description:
                "1-2 sentence summary of what the rep committed to: e.g. 'Rep Jenna A. agreed to reduce balance to $2,759.50; will send corrected statement in 7-10 days.'",
            },
          },
        },
      },
    },
    {
      type: "webhook",
      name: "request_human_handoff",
      description:
        "Call if the rep becomes hostile, threatens collections, mentions attorneys, or if you are stuck after escalating to a supervisor.",
      api_schema: {
        url: `${webhook_base_url}/request_human_handoff`,
        method: "POST",
        request_headers: authHeaders,
        request_body_schema: {
          type: "object",
          required: ["reason"],
          properties: {
            reason: {
              type: "string",
              enum: ["hostile", "legal_threat", "supervisor_refused", "unclear", "voicemail"],
            },
          },
        },
      },
    },
    {
      type: "webhook",
      name: "end_call",
      description: "End the call. Call this after recording the outcome or handing off to human.",
      api_schema: {
        url: `${webhook_base_url}/end_call`,
        method: "POST",
        request_headers: authHeaders,
        request_body_schema: {
          type: "object",
          required: ["outcome"],
          properties: {
            outcome: {
              type: "string",
              enum: ["success", "partial", "no_adjustment", "handoff", "voicemail_left", "dropped"],
            },
          },
        },
      },
    },
  ];

  const systemPrompt = CALL_SYSTEM_PROMPT_TEMPLATE({
    result,
    floor,
    bill_kind,
    account_holder_name,
  });
  const firstMessage = FIRST_MESSAGE_TEMPLATE(result, bill_kind, account_holder_name);

  const agentNameSuffix = bill_kind === "medical"
    ? (result.metadata.claim_number ?? "unknown claim")
    : (result.metadata.account_number ?? `${bill_kind} account`);
  return {
    name: `Bonsai negotiation — ${agentNameSuffix}`,
    conversation_config: {
      agent: {
        prompt: {
          prompt: systemPrompt,
          llm,
          temperature,
          tools,
        },
        first_message: firstMessage,
        language: "en",
      },
      tts: voice_id ? { voice_id } : undefined,
    },
    platform_settings: {
      privacy: {
        record_voice: true,
        retention_days: 90,
      },
    },
  };
}

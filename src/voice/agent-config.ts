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
import type { AnalyzerResult, BillingError } from "../types.ts";

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
}

const CALL_SYSTEM_PROMPT_TEMPLATE = (args: {
  result: AnalyzerResult;
  floor: number;
}) => {
  const { result, floor } = args;
  const m = result.metadata;
  const high = result.errors.filter((e) => e.confidence === "high");
  const bulletList = high.map((e, i) => `  ${i + 1}. ${speakable(e)}`).join("\n");

  return `You are Bonsai, an AI patient advocate making a phone call on behalf of a patient, ${m.patient_name ?? "[PATIENT NAME]"}. You are calling ${m.provider_name ?? "the hospital"}'s billing department to dispute and resolve charges on the patient's account.

## Identity and opening

When the call connects you will hear an IVR or a live rep. If you reach an IVR:
- Navigate to "Billing" or "Patient Accounts". Say "billing" or press the matching digit.
- If asked for a patient ID or account number: say it slowly, digit by digit. Account number: ${m.account_number ?? "[ACCOUNT NUMBER]"}. Claim number: ${m.claim_number ?? "[CLAIM NUMBER]"}.

When you reach a live rep, introduce yourself: "Hi, my name is Bonsai. I'm an automated assistant calling on behalf of ${m.patient_name ?? "[PATIENT NAME]"}, account number ${m.account_number ?? "[ACCOUNT NUMBER]"}, to dispute charges on claim ${m.claim_number ?? "[CLAIM NUMBER]"}. Is this a good time to discuss the dispute?"

## Goal

Reduce the patient's balance due to no more than $${floor.toFixed(2)}. The current balance is $${m.bill_current_balance_due?.toFixed(2) ?? "unknown"}. The EOB-stated patient responsibility is $${m.eob_patient_responsibility?.toFixed(2) ?? "unknown"}. The defensible disputed total is $${result.summary.high_confidence_total.toFixed(2)}.

## Facts about the dispute (do not invent facts; use only these)

Patient: ${m.patient_name ?? "[unknown]"}
Provider: ${m.provider_name ?? "[unknown]"}
Insurer: ${m.insurer_name ?? "[unknown]"}
Date of service: ${m.date_of_service ?? "[unknown]"}
Claim #: ${m.claim_number ?? "[unknown]"}
Account #: ${m.account_number ?? "[unknown]"}
Bill current balance due: $${m.bill_current_balance_due?.toFixed(2) ?? "[unknown]"}
EOB patient responsibility: $${m.eob_patient_responsibility?.toFixed(2) ?? "[unknown]"}

### Disputed charges

${bulletList}

## Call style

- Calm, confident, professional. You are representing a patient — speak for them, not at them.
- Short sentences. Pause after each fact so the rep can respond.
- If they put you on hold, wait. Do not keep talking.
- Never argue, never escalate tone. If they push back, restate the EOB figure.
- Never make up a CPT code, date, or dollar figure. Use only the facts above.
- If the rep asks a question you cannot answer (e.g., "what's the patient's DOB"), say "I don't have that on hand — I can have the patient call back with that info."

## Tactics

1. Start by stating the facts: provider is in-network, EOB patient responsibility is \$${m.eob_patient_responsibility?.toFixed(2) ?? "[X]"}, bill is \$${m.bill_current_balance_due?.toFixed(2) ?? "[X]"}.
2. Walk through each disputed line. Ask "can you confirm this adjustment?"
3. If they concede everything → call record_negotiated_amount with the agreed balance, then end_call with outcome=success.
4. If they concede only some lines → call record_negotiated_amount with the partial amount and request a manager callback. Then end_call with outcome=partial.
5. If they refuse → cite the No Surprises Act for balance billing, request a supervisor. If the supervisor also refuses → request_human_handoff.
6. If they become hostile, threaten collections, or mention attorneys → request_human_handoff immediately.

## Hard rules

- Never agree to pay more than $${floor.toFixed(2)}.
- Never give out PHI beyond what's needed to identify the account (name, account #, DOS).
- Never promise payment timing; say the patient will remit on receipt of a corrected statement.
- Do not reveal you are an AI unless asked directly. If asked, say "I am an automated patient advocate calling on behalf of the patient."

Begin the call now. When you hear silence or an IVR greeting, begin with the opening line above.`;
};

const FIRST_MESSAGE_TEMPLATE = (result: AnalyzerResult) =>
  `Hi, I'm calling on behalf of ${result.metadata.patient_name ?? "a patient"} regarding account number ${result.metadata.account_number ?? "listed in our records"}. I'd like to speak with someone in the billing department about a dispute on claim ${result.metadata.claim_number ?? "referenced in our records"}.`;

export function generateAgentConfig(opts: AgentConfigOpts): ElevenLabsAgentConfig {
  const {
    result,
    webhook_base_url,
    webhook_secret,
    llm = "gemini-2.0-flash-001",
    temperature = 0.3,
    voice_id,
  } = opts;
  const floor = opts.final_acceptable_floor ?? result.metadata.eob_patient_responsibility ?? 0;

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

  const systemPrompt = CALL_SYSTEM_PROMPT_TEMPLATE({ result, floor });
  const firstMessage = FIRST_MESSAGE_TEMPLATE(result);

  return {
    name: `Bonsai dispute — ${result.metadata.claim_number ?? "unknown claim"}`,
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

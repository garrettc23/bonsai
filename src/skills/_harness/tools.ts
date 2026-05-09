/**
 * Negotiation tool schemas — extracted from negotiate-email.ts so the
 * draft-reply skill (and Phase 5b's harness rewrite) can share them.
 *
 * Typed as `Anthropic.Tool` because today's caller (negotiate-email.ts)
 * still hits the Anthropic SDK directly. The shapes are identical to
 * `LLMTool` from src/llm/provider.ts at runtime — Phase 5b will route
 * through callLLM and switch the type. No content change required when
 * that lands.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const SEND_EMAIL_TOOL: Anthropic.Tool = {
  name: "send_email",
  description:
    "Draft and send the next outbound email in the negotiation thread. This sends the message immediately; do not compose a draft and then call this as a preview.",
  input_schema: {
    type: "object",
    required: ["subject", "body_text"],
    properties: {
      subject: {
        type: "string",
        minLength: 3,
        description: "Subject line. For replies, preserve the original subject with 'Re: ' prefix.",
      },
      body_text: {
        type: "string",
        minLength: 50,
        description:
          "Plain-text email body. Do NOT use markdown formatting — the message ships as plain text, so any markdown punctuation renders as literal characters in Gmail/Outlook. Forbidden: `**bold**`, `__bold__`, `_italic_`, `*italic*`, `# Headings`, `> blockquotes`, and backticks. Hyphen-space bullets (`- item`) are fine because they read as plain text. Include a greeting, 1–3 short paragraphs, and a signature block.\n\nDo: We're disputing the $900 balance-billing charge on claim CLM-001. Per the EOB, patient responsibility is $100.\nDon't: **We are disputing** the `$900` balance-billing charge on _claim CLM-001_. ## Background — per the EOB, patient responsibility is $100.",
      },
    },
  },
};

export const MARK_RESOLVED_TOOL: Anthropic.Tool = {
  name: "mark_resolved",
  description:
    "Call when the billing department has agreed to correct the account or reduce the balance to an acceptable amount. In autonomous mode this terminates the thread. In co-pilot mode it routes the proposed resolution to the user for accept/push-back. If the rep is asking the user to sign anything binding, set requires_signature=true and the user will always be asked to confirm regardless of mode.",
  input_schema: {
    type: "object",
    required: ["resolution", "final_amount_owed", "notes"],
    properties: {
      resolution: {
        type: "string",
        enum: ["full_adjustment", "reduced", "no_adjustment"],
        description:
          "full_adjustment = balance reduced to EOB responsibility or below; reduced = between EOB and original bill but at/under final_acceptable_floor; no_adjustment = patient conceded original balance (should be rare).",
      },
      final_amount_owed: {
        type: "number",
        minimum: 0,
        description: "Final dollar amount the patient owes after resolution.",
      },
      notes: {
        type: "string",
        minLength: 10,
        description: "1–3 sentence summary of how we got here and what the provider committed to.",
      },
      requires_signature: {
        type: "boolean",
        description:
          "True when the rep is asking the user to sign, initial, or otherwise commit to a binding document (insurance release, debt-settlement agreement, lease addendum, 'reply YES to confirm', etc). When true, the user is ALWAYS asked to review before the resolution is final, even in autonomous mode. When in doubt, set true.",
      },
      signature_doc_summary: {
        type: "string",
        description:
          "Required when requires_signature=true. One-sentence plain-English description of what the user is being asked to sign (e.g., 'a release of all future claims related to this hospital stay').",
      },
    },
  },
};

export const ESCALATE_HUMAN_TOOL: Anthropic.Tool = {
  name: "escalate_human",
  description:
    "Call when the situation needs a human: hostile reply, legal threats, deadlock after 3 denials, or unclear/missing info.",
  input_schema: {
    type: "object",
    required: ["reason", "notes"],
    properties: {
      reason: {
        type: "string",
        enum: ["hostile", "legal", "unclear", "deadlock", "user_judgment_required"],
      },
      notes: { type: "string", minLength: 10 },
    },
  },
};

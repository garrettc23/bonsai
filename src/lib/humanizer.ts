/**
 * Humanizer pass for outbound emails.
 *
 * Every external email Bonsai sends — initial appeal letter, negotiation
 * follow-ups, complaint letters — runs through this module before hitting
 * the wire. The goal is to make the message sound like it came from a real
 * customer, not a template, while preserving every fact the analyzer
 * grounded.
 *
 * What the humanizer does:
 *   - Rewrites tone to match the user's preference (polite / firm / aggressive)
 *   - Strips AI-isms ("I hope this email finds you well", "I am writing to
 *     formally...", "Pursuant to our records...")
 *   - Drops empty bracketed placeholders ([CLAIM NUMBER], [ACCOUNT NUMBER])
 *     instead of leaving them in
 *   - Enforces concise (1–3 short paragraphs by default; only longer if
 *     the situation demands it)
 *   - For recurring-charge bills (telecom, subscription, insurance), bakes
 *     in the retention talk track: "saw the price increase, can no longer
 *     stay at this price, shopping around, want my old rate back / months
 *     credited"
 *
 * What it must NOT do (hard constraints in the system prompt):
 *   - Invent dollar figures, claim numbers, dates, CPT codes — the
 *     analyzer's verbatim line_quotes and dollar amounts have to flow
 *     through unchanged.
 *   - Add legal threats not in the source.
 *   - Change the substantive ask.
 *
 * Why a separate Opus call instead of folding this into the negotiation
 * agent's prompt? Two reasons. (1) The negotiation agent already has a
 * heavy job — classifying replies, picking next moves, calling tools — so
 * giving it a second responsibility (sounding human) muddies its main
 * task. (2) The initial appeal letter is generated deterministically by
 * appeal-letter.ts, never by an LLM, so it never gets the tone/style
 * treatment without a separate pass.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentTone } from "./user-settings.ts";
import type { BillKind } from "../types.ts";
import { toneGuidance } from "./feedback-parser.ts";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 2048;

export interface HumanizeOpts {
  /** The drafted email body (markdown). */
  body: string;
  /** Subject line — humanizer can tighten but should not change semantics. */
  subject: string;
  /** User's preferred agent tone. Defaults to "firm". */
  tone?: AgentTone;
  /** Drives the playbook: medical = NSA / EOB framing; telecom/subscription
   * /insurance = retention play; everything else = generic billing dispute. */
  bill_kind?: BillKind;
  /** First time we're contacting this provider on this thread. Drives the
   * "I've been a loyal customer" framing for retention plays. */
  is_first_contact?: boolean;
  /** Patient/customer name to sign as. If absent, the humanizer drops the
   * sign-off block instead of using a placeholder. */
  user_name?: string | null;
  /** Used to retain context: dollar figures, line quotes, dates that must
   * survive the rewrite verbatim. The humanizer is told NOT to invent or
   * paraphrase these. */
  preserve_facts?: string[];
  /** Inject an Anthropic client so tests / orchestrators can mock or share
   * one. Defaults to a fresh `new Anthropic()` from env. */
  anthropic?: Anthropic;
}

export interface HumanizeResult {
  body: string;
  subject: string;
}

/**
 * Single Opus call that takes a drafted email and returns a tone-adjusted,
 * human-sounding rewrite. Falls back to the input on error so a humanizer
 * outage never blocks a send.
 */
export async function humanize(opts: HumanizeOpts): Promise<HumanizeResult> {
  // Test escape hatch — set in unit tests so the humanizer doesn't make a
  // real Anthropic call. Production never sets this. Integration tests
  // that need to exercise the humanizer should leave it unset and inject
  // an Anthropic mock via opts.anthropic.
  if (process.env.BONSAI_DISABLE_HUMANIZER === "1") {
    return { subject: opts.subject, body: opts.body };
  }
  const tone: AgentTone = opts.tone ?? "firm";
  const kind: BillKind = opts.bill_kind ?? "other";
  const playbook = pickPlaybook(kind);

  const factsBlock = opts.preserve_facts?.length
    ? `\n\n## Facts that MUST survive verbatim\n\nThese came from a grounded audit. Do not rephrase, round, or omit them — they are the basis of the dispute:\n${opts.preserve_facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
    : "";

  const signBlock = opts.user_name
    ? `Sign the email as: ${opts.user_name}.`
    : `If a sign-off is needed, use a generic close ("Thanks," "Best,") with no name. Do not insert a placeholder like "[NAME]".`;

  const system = `You are Bonsai's humanizer. You receive a drafted external email and rewrite it so it sounds like a real customer wrote it — not a template, not an AI, not a lawyer. You preserve every grounded fact and the substantive ask, and you apply the user's tone preference to the surface language.

## Required output

Return your rewrite via the \`humanize_email\` tool. No prose outside the tool call.

## Hard rules (non-negotiable)

1. Preserve every dollar figure, claim number, account number, date, and direct quote from the original. If the original quotes a bill line in quotation marks, that quote is verbatim and must survive the rewrite unchanged.
2. Do NOT invent claim numbers, account numbers, or dates that are not in the input. If the original has a placeholder like "[CLAIM NUMBER]" or "[ACCOUNT NUMBER]", drop the entire reference (and the surrounding sentence if needed). Never leave brackets in the output.
3. Do NOT change the substantive ask. If the original asks for a refund of $X, the rewrite asks for a refund of $X.
4. Do NOT add legal threats, statutes, or escalation paths that weren't in the original. Soften or keep — never add.

## Style rules

5. Default length: 1–3 short paragraphs. Only go longer if the original genuinely requires it (e.g., a multi-finding medical dispute with itemized lines). When in doubt, cut.
6. Strip AI-isms and corporate boilerplate: "I hope this email finds you well", "I am writing to formally", "pursuant to our records", "as per", "I would like to take this opportunity to". Open with the actual reason for the email.
7. Use plain, natural English. Contractions are fine. No hedging ("I just wanted to ask…"). No throat-clearing.
8. No markdown formatting. The body ships to the recipient as plain text — markdown punctuation renders as literal characters in Gmail/Outlook. Do NOT introduce \`**bold**\`, \`__bold__\`, \`_italic_\`, \`*italic*\`, \`# headings\`, \`> blockquotes\`, or backticks. If the input has any of these, drop the punctuation and keep the words. Hyphen-space bullets (\`- item\`) are fine — they read as plain text. Snake_case identifiers (claim_number, account_number_123) are not emphasis; preserve them verbatim.
9. ${signBlock}
10. Keep the subject line if it's already concrete; tighten if it's flabby. Never lengthen it.

## Tone — user selected: ${tone}

${toneGuidance(tone)}

## Playbook for this bill kind: ${kind}

${playbook}${factsBlock}`;

  const HUMANIZE_TOOL: Anthropic.Tool = {
    name: "humanize_email",
    description: "Return the rewritten subject + body.",
    input_schema: {
      type: "object",
      required: ["subject", "body_markdown"],
      properties: {
        subject: { type: "string", minLength: 3 },
        body_markdown: { type: "string", minLength: 20 },
      },
    },
  };

  const userMsg = `## Original drafted email

Subject: ${opts.subject}

${opts.body}

## Your task

Rewrite the body in the user's tone. Preserve every grounded fact (dollar figures, dates, claim/account numbers, direct quotes) verbatim. Drop empty placeholders. Apply the playbook above. Return via the humanize_email tool.${opts.is_first_contact ? "\n\nThis is the FIRST contact on this thread, so the playbook's opening framing applies." : "\n\nThis is a FOLLOW-UP on an existing thread; skip introductions and respond to whatever the rep last said."}`;

  try {
    const anthropic = opts.anthropic ?? new Anthropic();
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: [HUMANIZE_TOOL],
      tool_choice: { type: "tool", name: "humanize_email" },
      messages: [{ role: "user", content: userMsg }],
    });
    const tool = resp.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "humanize_email",
    );
    if (!tool) {
      console.warn("[humanizer] no tool call in response, falling back to original");
      return { subject: opts.subject, body: opts.body };
    }
    const input = tool.input as { subject: string; body_markdown: string };
    return { subject: input.subject, body: input.body_markdown };
  } catch (err) {
    // Never block a send on a humanizer failure — log and fall through.
    console.warn(`[humanizer] failed, sending original: ${(err as Error).message}`);
    return { subject: opts.subject, body: opts.body };
  }
}

/**
 * Bill-kind-specific guidance the humanizer applies. Recurring-charge kinds
 * get the retention talk track; medical gets the NSA/EOB framing the
 * appeal letter assumes; everything else gets generic billing-dispute
 * guidance.
 */
function pickPlaybook(kind: BillKind): string {
  if (kind === "telecom" || kind === "subscription" || kind === "insurance") {
    return `RECURRING-CHARGE RETENTION PLAY. Address the email to the retention or customer-loyalty team, not sales. If the rep tries to route you to a sales rep or "new offers", explicitly ask to speak with retention or a retention officer. The opening framing for first contact: "I noticed this price increase, and unfortunately I can't continue at this rate. I'm shopping around and looking at other providers." Then the leverage: "I've been a loyal customer for [time]. The fact that I had to reach out to discover this myself is disappointing. To stay, I need [X months credited / old rate restored / equivalent value]." Push for the maximum credit reasonable. Keep the ask explicit and quantified.`;
  }
  if (kind === "medical") {
    return `MEDICAL BILLING DISPUTE. Address the email to the billing department or patient accounts. The frame is: insurer's EOB sets the patient responsibility ceiling, the bill exceeds it, the dispute is documented in the original appeal. Cite statutes only when the original draft did — don't add new ones. Keep the No Surprises Act / FCRA references if they're present. Avoid emotional language; this is a paperwork dispute.`;
  }
  if (kind === "utility") {
    return `UTILITY BILLING DISPUTE. Address customer support or account services. Hardship programs, budget billing, and meter-read corrections are common levers. Don't cite federal statutes — utility disputes are state-level and the original draft will already have the right framing if it applies.`;
  }
  if (kind === "financial") {
    return `FINANCIAL-CHARGE DISPUTE. Address the customer service or disputes team. Common levers: fee waivers (overdraft, late fee, foreign transaction), interest rate reduction, hardship programs. Reference your account history if the original mentioned it. CFPB complaint as backstop.`;
  }
  return `GENERIC BILLING DISPUTE. Address customer support or billing. Lead with the specific charge being disputed, the amount, and the resolution you want. Avoid sales reps — if the rep tries to sell something, explicitly ask to speak with billing or a supervisor.`;
}

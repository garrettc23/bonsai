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
import type { AgentTone } from "./user-settings.ts";
import type { BillKind } from "../types.ts";
import { toneGuidance } from "./feedback-parser.ts";
import { loadSkill, renderSkill } from "../skills/_harness/skill-loader.ts";
import { callLLM, type LLMTool, type ProviderRunners } from "../llm/provider.ts";

const HUMANIZE_TOOL: LLMTool = {
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
  /** Hard word cap for the rewritten body. Defaults to 200 for first
   * contact, 120 for follow-ups. After the rewrite returns, we count
   * words; if it's > 20% over cap, we retry once with a stricter prompt.
   * If the retry is still over, we truncate at the nearest paragraph
   * boundary and log a `humanizer.cap_violation` warning. Set to 0 to
   * disable the cap entirely (used by the appeal-letter pre-pass where
   * a long structured letter is intentional). */
  max_words?: number;
  /** Inject mock LLM runners so tests can stub provider calls. Production
   * leaves this undefined and the real Anthropic/OpenAI SDKs are used. */
  runners?: ProviderRunners;
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
  // mock runners via opts.runners.
  if (process.env.BONSAI_DISABLE_HUMANIZER === "1") {
    return { subject: opts.subject, body: opts.body };
  }
  const tone: AgentTone = opts.tone ?? "firm";
  const kind: BillKind = opts.bill_kind ?? "other";
  // Default caps come from the plan: 200 words for first contact (room for
  // the dispute framing), 120 words for follow-ups (the rep already knows
  // what we're asking). Caller can override per-call. 0 disables the cap
  // entirely — used by the appeal-letter pre-pass.
  const capWords =
    opts.max_words !== undefined
      ? Math.max(0, opts.max_words)
      : opts.is_first_contact
        ? 200
        : 120;
  const playbook = pickPlaybook(kind);

  const system = renderSkill(loadSkill("humanize"), {
    tone,
    tone_guidance: toneGuidance(tone),
    bill_kind: kind,
    playbook,
    length_rule: lengthRule(capWords, opts.is_first_contact ?? false),
    sign_block: signBlock(opts.user_name),
    facts_block: factsBlock(opts.preserve_facts),
  });

  const userMsg = `## Original drafted email

Subject: ${opts.subject}

${opts.body}

## Your task

Rewrite the body in the user's tone. Preserve every grounded fact (dollar figures, dates, claim/account numbers, direct quotes) verbatim. Drop empty placeholders. Apply the playbook above. Return via the humanize_email tool.${opts.is_first_contact ? "\n\nThis is the FIRST contact on this thread, so the playbook's opening framing applies." : "\n\nThis is a FOLLOW-UP on an existing thread; skip introductions and respond to whatever the rep last said."}`;

  try {
    const skill = loadSkill("humanize");
    const resp = await callLLM(
      {
        provider: skill.frontmatter.provider,
        model: skill.frontmatter.model,
        max_tokens: skill.frontmatter.max_tokens,
        system,
        user: userMsg,
        tools: [HUMANIZE_TOOL],
        force_tool: "humanize_email",
      },
      opts.runners,
    );
    if (!resp.tool_use || resp.tool_use.name !== "humanize_email") {
      console.warn("[humanizer] no tool call in response, falling back to original");
      return { subject: opts.subject, body: opts.body };
    }
    const input = resp.tool_use.input as { subject: string; body_markdown: string };
    let result: HumanizeResult = { subject: input.subject, body: input.body_markdown };
    if (capWords > 0) {
      result = await enforceWordCap(result, capWords, system, skill.frontmatter, opts.runners);
    }
    // Defensive: if compression / truncation produced an empty body, fall
    // back to the original draft so we never ship a blank email to a rep.
    if (!result.body.trim()) {
      console.warn("[humanizer] empty body after enforceWordCap, falling back to original");
      return { subject: result.subject || opts.subject, body: opts.body };
    }
    return result;
  } catch (err) {
    // Never block a send on a humanizer failure — log and fall through.
    console.warn(`[humanizer] failed, sending original: ${(err as Error).message}`);
    return { subject: opts.subject, body: opts.body };
  }
}

/** Tokenize on whitespace. Cheap, deterministic, good enough for a cap. */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Enforce the word cap on the rewritten body. Three-tier strategy:
 *   1. Under cap or at most 20% over → return as-is. The cap is a target
 *      not a hard line; LLM word counts wobble.
 *   2. Over cap by >20% → ONE retry with a stricter compress prompt.
 *      Specifically tells Opus the previous word count and the cap so it
 *      can't fudge the comparison.
 *   3. Retry still over → truncate at the nearest paragraph break that
 *      fits, append nothing (no ellipsis). Log a `humanizer.cap_violation`
 *      so dashboards can track drift.
 *
 * No infinite re-prompts. Two API calls max per humanize().
 */
async function enforceWordCap(
  draft: HumanizeResult,
  cap: number,
  originalSystem: string,
  skillFm: { provider: "anthropic" | "openai"; model: string; max_tokens: number },
  runners: ProviderRunners | undefined,
): Promise<HumanizeResult> {
  const initial = countWords(draft.body);
  if (initial <= cap * 1.2) return draft;

  try {
    const resp = await callLLM(
      {
        provider: skillFm.provider,
        model: skillFm.model,
        max_tokens: skillFm.max_tokens,
        system: originalSystem,
        user: `Your previous output was ${initial} words. The cap is ${cap} words. Cut sentences — don't shorten them, drop the least load-bearing ones entirely. Return the compressed subject + body via the humanize_email tool.\n\nPrevious subject: ${draft.subject}\n\nPrevious body:\n${draft.body}`,
        tools: [HUMANIZE_TOOL],
        force_tool: "humanize_email",
      },
      runners,
    );
    if (resp.tool_use && resp.tool_use.name === "humanize_email") {
      const input = resp.tool_use.input as { subject: string; body_markdown: string };
      const retryWords = countWords(input.body_markdown);
      if (retryWords <= cap * 1.2) {
        return { subject: input.subject, body: input.body_markdown };
      }
      // Still over after one retry — truncate the retry at a paragraph
      // boundary; it's already the best version we'll get.
      console.warn(`[humanizer.cap_violation] retry still over: cap=${cap} got=${retryWords}`);
      return {
        subject: input.subject,
        body: truncateAtParagraph(input.body_markdown, cap),
      };
    }
  } catch (err) {
    console.warn(`[humanizer] retry failed: ${(err as Error).message}`);
  }
  // Retry totally failed — truncate the original draft.
  console.warn(`[humanizer.cap_violation] truncating draft: cap=${cap} got=${initial}`);
  return { subject: draft.subject, body: truncateAtParagraph(draft.body, cap) };
}

/** Cut the body to a paragraph boundary that fits under the cap. If the
 * first paragraph alone is over cap, fall back to a hard word slice
 * — without that fallback, the loop pushes the over-cap paragraph
 * (because acc.length === 0 disables the guard) and returns more than
 * cap words. */
function truncateAtParagraph(body: string, cap: number): string {
  const paragraphs = body.split(/\n\n+/);
  // First paragraph alone exceeds cap → there's no paragraph boundary that
  // fits, hard-slice instead. Common case for one-sentence rep responses
  // that the agent over-pads.
  const firstWords = countWords(paragraphs[0] ?? "");
  if (firstWords > cap) {
    return body.trim().split(/\s+/).slice(0, cap).join(" ");
  }
  let acc: string[] = [];
  let words = 0;
  for (const p of paragraphs) {
    const w = countWords(p);
    if (words + w > cap) break;
    acc.push(p);
    words += w;
    if (words >= cap) break;
  }
  if (acc.length === 0) {
    return body.trim().split(/\s+/).slice(0, cap).join(" ");
  }
  return acc.join("\n\n");
}

/**
 * The "Hard length cap" sentence that gets injected into the humanize
 * skill's style-rule #5. The wording shifts depending on whether the cap
 * is enforced (capWords > 0) and whether this is first contact vs a
 * follow-up (drives the structural template the model is told to hit).
 */
function lengthRule(capWords: number, isFirstContact: boolean): string {
  if (capWords > 0) {
    const which = isFirstContact ? "first-contact" : "follow-up";
    return `the body MUST be at or under ${capWords} words. Count your words. If your draft would go over, cut sentences (don't shorten them — drop the least load-bearing ones entirely). Default ${which} structure: greeting (1 line), the ask + the strongest grounded fact (1 short paragraph), close (1 line)`;
  }
  return `1–3 short paragraphs. Only go longer if the original genuinely requires it (e.g., a multi-finding medical dispute with itemized lines). When in doubt, cut`;
}

function signBlock(userName: string | null | undefined): string {
  return userName
    ? `Sign the email as: ${userName}.`
    : `If a sign-off is needed, use a generic close ("Thanks," "Best,") with no name. Do not insert a placeholder like "[NAME]".`;
}

function factsBlock(facts: string[] | undefined): string {
  if (!facts?.length) return "";
  return `\n\n## Facts that MUST survive verbatim\n\nThese came from a grounded audit. Do not rephrase, round, or omit them — they are the basis of the dispute:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
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

/**
 * Turn free-text user feedback ("stop being aggressive, email only, no calls")
 * into structured directives the negotiation agent can honor on the next round.
 *
 * Deterministic keyword matching — cheap, predictable, no Claude roundtrip.
 * Anything we can't parse survives as a free-form note that still gets
 * appended to the agent's system prompt so Claude can interpret it.
 */
import type { AgentTone } from "./user-settings.ts";

export interface FeedbackDirectives {
  /** When set, only channels with `true` are allowed. Missing keys = inherit
   * from tune config. */
  channels?: { email?: boolean; voice?: boolean };
  /** Tone the user wants the agent to take. */
  tone?: AgentTone;
  /** Raw feedback lines, preserved so downstream prompts can see the original. */
  notes: string[];
}

const RE_EMAIL_ONLY = /\b(only\s+email|email\s+only|email[- ]only)\b/i;
const RE_VOICE_ONLY = /\bonly\s+(?:voice|phone|calls?)\b|\b(?:voice|phone|calls?)\s+only\b/i;

const RE_NO_CALL = /\b(no|stop|avoid|don'?t|skip|without)\s+(call|calls|phone|phones|voice|calling|phoning)\b/i;
const RE_NO_EMAIL = /\b(no|stop|avoid|don'?t|skip|without)\s+(email|emails|emailing)\b/i;

const RE_STOP_AGGRESSIVE =
  /\bstop\s+being\s+(?:so\s+)?aggressive\b|\b(?:less|not\s+so)\s+aggressive\b|\bback\s+off\b|\bease\s+up\b|\btone\s+it\s+down\b|\bdial\s+it\s+back\b|\bsofter\b/i;
const RE_BE_POLITE = /\bbe\s+(?:nice|nicer|polite|politer|gentler|gentle|kind|kinder)\b|\bmore\s+polite\b/i;
const RE_BE_AGGRESSIVE = /\bbe\s+(?:more\s+)?aggressive\b|\bpush\s+harder\b|\bbe\s+pushy\b|\bhardball\b/i;
const RE_BE_FIRM = /\bbe\s+firm(?:er)?\b|\bfirm\s+but\s+fair\b/i;

export function parseFeedbackDirectives(feedback: string[]): FeedbackDirectives {
  const text = feedback.join(" \n ");
  const out: FeedbackDirectives = {
    notes: feedback.map((f) => f.trim()).filter(Boolean),
  };

  // Exclusive "X only" overrides ALL channel flags.
  if (RE_EMAIL_ONLY.test(text)) {
    out.channels = { email: true, voice: false };
  } else if (RE_VOICE_ONLY.test(text)) {
    out.channels = { email: false, voice: true };
  } else {
    const chans: { email?: boolean; voice?: boolean } = {};
    if (RE_NO_EMAIL.test(text)) chans.email = false;
    if (RE_NO_CALL.test(text)) chans.voice = false;
    if (Object.keys(chans).length > 0) out.channels = chans;
  }

  if (RE_STOP_AGGRESSIVE.test(text) || RE_BE_POLITE.test(text)) {
    out.tone = "polite";
  } else if (RE_BE_AGGRESSIVE.test(text)) {
    out.tone = "aggressive";
  } else if (RE_BE_FIRM.test(text)) {
    out.tone = "firm";
  }

  return out;
}

export function toneGuidance(tone: AgentTone): string {
  // Trailing rule applies to every tone: the humanizer enforces a hard
  // word cap (200 first contact / 120 follow-ups) and the aggressive tone
  // in particular tends to add length (statute citations, escalation
  // paths). Tone wins on word choice; the cap wins on length.
  const lengthRule =
    " Stay within the word cap regardless of tone — cut sentences, do not shorten them.";
  if (tone === "polite") {
    return (
      "Dial back any confrontational language. Lead with gratitude and cooperation. Still cite facts and statutes when relevant, but phrase every request as an ask, never a demand. Offer to work with the rep." +
      lengthRule
    );
  }
  if (tone === "aggressive") {
    return (
      "Be assertive. Set firm short deadlines (7 days, not 14). Make consequences explicit — NSA enforcement, CFPB complaint, attorney referral, state AG if relevant. Stay professional but do not soften." +
      lengthRule
    );
  }
  return (
    "Be firm and matter-of-fact. Direct requests, clear deadlines, no hedging. Not hostile — but not apologetic either." +
    lengthRule
  );
}

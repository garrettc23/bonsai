/**
 * Defensive plain-text stripper for outbound email bodies.
 *
 * Resend ships our message as the `text:` field, so any markdown punctuation
 * lands as literal characters in Gmail/Outlook (`**bold**` → `**bold**`). The
 * negotiator's tool description and the humanizer's system prompt both ask
 * for plain text — this function is the belt-and-braces last line of
 * defense in case Claude drifts back into markdown habits.
 *
 * Conservative on purpose: snake_case identifiers like `claim_number` and
 * `account_number_123` must survive untouched (they appear verbatim in
 * billing disputes). Only treats `_x_` / `*x*` as emphasis when the
 * delimiters are at word boundaries.
 *
 * Idempotent: stripMarkdown(stripMarkdown(x)) === stripMarkdown(x).
 */

const FENCE_RE = /^\s*```.*$/gm;
const HEADING_RE = /^[ \t]*#{1,6}[ \t]+/gm;
const BLOCKQUOTE_RE = /^[ \t]*>[ \t]?/gm;
const BULLET_RE = /^([ \t]*)[*+][ \t]+/gm;

const BOLD_STAR_RE = /\*\*([^*\n]+?)\*\*/g;
const BOLD_UNDER_RE = /__([^_\n]+?)__/g;

// Italic with `*`: `(^|[\s(])*X*` where X has no `*` and doesn't start/end
// with whitespace, followed by end / whitespace / closing punctuation.
const ITALIC_STAR_RE = /(^|[\s(])\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*(?=$|[\s).,;:!?])/gm;
// Italic with `_`: open/close must sit at non-word boundaries (so plain
// snake_case identifiers like `claim_number` aren't touched), but the
// inner span IS allowed to contain `_` — which is what lets us strip
// `_claim_number_` down to `claim_number`. Non-greedy middle means
// `_a_b_c_` becomes `a_b_c`, not `_a_b_c_` → mismatched.
const ITALIC_UNDER_RE = /(^|[^\w])_([^\s_](?:[^\n]*?[^\s_])?)_(?!\w)/gm;

const BACKTICK_INLINE_RE = /`([^`\n]+?)`/g;

export function stripMarkdown(input: string): string {
  let out = input;
  out = out.replace(FENCE_RE, "");
  out = out.replace(HEADING_RE, "");
  out = out.replace(BLOCKQUOTE_RE, "");
  out = out.replace(BULLET_RE, "$1- ");
  out = out.replace(BOLD_STAR_RE, "$1");
  out = out.replace(BOLD_UNDER_RE, "$1");
  out = out.replace(ITALIC_STAR_RE, "$1$2");
  out = out.replace(ITALIC_UNDER_RE, "$1$2");
  out = out.replace(BACKTICK_INLINE_RE, "$1");
  return out;
}

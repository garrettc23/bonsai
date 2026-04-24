/**
 * Ground-truth text for validation.
 *
 * Our fixture bills come from markdown sources (`fixtures/bill-*.md`).
 * We use that markdown as the authoritative text for line_quote validation
 * rather than re-extracting from the PDF — it's deterministic and avoids
 * PDF-parsing drift.
 *
 * For real user-uploaded PDFs (post-hackathon), swap this for `unpdf` or
 * another text extractor. The rest of the pipeline doesn't care where the
 * text comes from.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "fixtures");

export interface GroundTruth {
  /** Raw markdown text with YAML front matter stripped. */
  text: string;
  /** Normalized form used for fuzzy matching — see normalize(). */
  normalized: string;
  /** Path to the source file (for debugging). */
  source: string;
}

/**
 * Normalize for fuzzy comparison:
 *   - drop markdown structural chars: pipes, bold/italic markers, headers
 *   - treat colons as word separators
 *   - collapse whitespace
 *   - lowercase
 *
 * Claude's line_quote may drop markdown formatting (the PDF Claude reads
 * doesn't have `**bold**` in it — that's only in our source markdown),
 * compress spaces, or use different delimiters. We normalize both sides
 * to the same shape and match on semantic content.
 */
export function normalize(s: string): string {
  return s
    .replace(/[|*_#]/g, " ") // markdown structural chars
    .replace(/:/g, " ") // "Current Balance Due:" = "Current Balance Due"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function loadGroundTruth(fixtureName: string): GroundTruth {
  // Accept either "bill-001" or "bill-001.md" or a full path.
  const bare = fixtureName.replace(/\.md$/, "").replace(/\.pdf$/, "");
  const mdPath = join(FIXTURES_DIR, `${bare}.md`);
  const raw = readFileSync(mdPath, "utf8").replace(/^---[\s\S]*?---\n/, "");
  return {
    text: raw,
    normalized: normalize(raw),
    source: mdPath,
  };
}

/**
 * Build a GroundTruth from already-extracted text (e.g. a Claude transcript
 * of an uploaded image/PDF). Same grounding contract as loadGroundTruth —
 * every record_error line_quote will be checked against `text`.
 */
export function groundTruthFromText(text: string, source: string): GroundTruth {
  return {
    text,
    normalized: normalize(text),
    source,
  };
}

/**
 * Check whether a quoted string appears in the ground truth.
 * Returns `{ found: true }` on success, or `{ found: false, reason }` on failure.
 *
 * Matching strategy:
 *   1. Normalize both sides (collapse whitespace + drop pipes + lowercase).
 *   2. Direct substring check on normalized strings.
 *   3. If the quote has multiple tokens, also try matching 80% of consecutive
 *      tokens (handles cases where Claude inserts a word or drops a delimiter).
 */
export function quoteAppearsIn(quote: string, truth: GroundTruth): { found: boolean; reason?: string } {
  const nq = normalize(quote);
  if (nq.length < 4) {
    return { found: false, reason: "line_quote too short to be meaningful" };
  }
  if (truth.normalized.includes(nq)) {
    return { found: true };
  }
  // Fallback: consecutive-token window match.
  const tokens = nq.split(" ").filter((t) => t.length > 1);
  if (tokens.length < 3) {
    return { found: false, reason: `line_quote not found in bill (normalized: "${nq.slice(0, 80)}...")` };
  }
  // Try the longest N% contiguous sub-phrase. Handles Claude adding a stray word.
  const minTokens = Math.max(3, Math.ceil(tokens.length * 0.8));
  for (let start = 0; start <= tokens.length - minTokens; start++) {
    const sub = tokens.slice(start, start + minTokens).join(" ");
    if (truth.normalized.includes(sub)) {
      return { found: true };
    }
  }
  return {
    found: false,
    reason: `line_quote not found in bill. Quote was: "${quote.slice(0, 120)}${quote.length > 120 ? "..." : ""}". Quote verbatim from the bill document.`,
  };
}

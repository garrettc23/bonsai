/**
 * Extract text from a PDF using `unpdf` (a fork of pdf.js packaged for
 * serverless / non-DOM runtimes — no native deps, Bun-friendly).
 *
 * For text-based PDFs we get the embedded text stream directly; the
 * grounding contract in `ground-truth.ts` then validates every Claude
 * `line_quote` against this output verbatim (modulo whitespace).
 *
 * For scanned / image-only PDFs there is no embedded text. We deliberately
 * do NOT fall back to OCR — a hallucinated OCR string could slip past
 * `quoteAppearsIn` and weaken the contract that makes Bonsai trustworthy.
 * Instead we raise `ScannedPdfError` so the upload route can surface a
 * clear "this looks scanned, paste rows or upload a text PDF" message.
 */
import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";

const MIN_CHARS_PER_PAGE = 40;

export class ScannedPdfError extends Error {
  readonly code = "SCANNED_PDF";
  constructor(message: string) {
    super(message);
    this.name = "ScannedPdfError";
  }
}

export interface ExtractedPdf {
  pages: string[];
  full: string;
  totalPages: number;
}

export async function extractPdfText(path: string): Promise<ExtractedPdf> {
  const bytes = await readFile(path);
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const trimmedTotal = pages.reduce((n, p) => n + p.trim().length, 0);
  if (totalPages > 0 && trimmedTotal / totalPages < MIN_CHARS_PER_PAGE) {
    throw new ScannedPdfError(
      "This PDF appears to be scanned (no extractable text). " +
        "Re-upload a text-based PDF, or paste itemized rows manually.",
    );
  }
  const full = pages.join("\n\n");
  return { pages, full, totalPages };
}

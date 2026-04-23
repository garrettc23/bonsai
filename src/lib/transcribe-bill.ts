/**
 * Claude-driven verbatim transcription of a bill.
 *
 * The grounding check (`quoteAppearsIn`) needs a text copy of the bill so
 * that every `line_quote` Claude cites during the audit can be validated.
 * For shipped fixtures this text comes from `fixtures/*.md`. For live
 * uploads we don't have that — so we ask Claude to transcribe the
 * uploaded file to plaintext and use that transcript as the ground truth.
 *
 * The transcription is permissive (goal: capture every printed glyph), the
 * audit that follows is strict (quote must appear in this text).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { NormalizedBill } from "./extract-bill.ts";

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are a document transcription tool. Your job is to output a verbatim plaintext transcript of a medical bill (or EOB) exactly as it appears in the uploaded file.

Rules:
- Preserve every printed glyph: headers, labels, line items, codes, quantities, dollar amounts, dates, totals.
- For tables, write one row per line, separating cells with " | ".
- Do not summarize, paraphrase, reorder, or add commentary.
- Do not add markdown, code fences, or explanations. Output the raw transcript and nothing else.
- If a field is illegible, write [illegible] in its place.`;

export interface TranscribeOpts {
  bill: NormalizedBill;
  role?: "bill" | "eob";
  anthropicClient?: Anthropic;
}

function contentBlock(bill: NormalizedBill): Anthropic.Messages.ContentBlockParam {
  if (bill.kind === "document") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: bill.base64 },
    };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: bill.mediaType, data: bill.base64 },
  };
}

export async function transcribeBill(opts: TranscribeOpts): Promise<string> {
  const client = opts.anthropicClient ?? new Anthropic();
  const role = opts.role ?? "bill";
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          contentBlock(opts.bill),
          {
            type: "text",
            text: `Transcribe this ${role === "eob" ? "insurance Explanation of Benefits (EOB)" : "medical bill"} verbatim.`,
          },
        ],
      },
    ],
  });

  const parts = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text);
  const text = parts.join("\n").trim();
  if (!text) {
    throw new Error("Transcription returned empty text — the uploaded file may not be a readable bill.");
  }
  return text;
}

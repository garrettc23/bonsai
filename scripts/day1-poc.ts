/**
 * Day 1 POC — proves the end-to-end reasoning loop works.
 *
 * Feeds bill-001.pdf + eob-001.pdf to Claude as native PDF inputs, asks for
 * a prose list of errors. No tools yet, no grounding contract yet — those
 * arrive Day 2. The goal here is: confirm Claude can read our fixtures and
 * produce substantive findings that we can then constrain and verify.
 *
 * Usage:
 *   bun run day1   (or:  npx tsx scripts/day1-poc.ts)
 */
import "../src/env.ts";
import { validateRequiredEnv } from "../src/env.ts";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

validateRequiredEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

const BILL_PATH = join(FIXTURES_DIR, "bill-001.pdf");
const EOB_PATH = join(FIXTURES_DIR, "eob-001.pdf");

function loadPdfAsBase64(path: string): string {
  try {
    return readFileSync(path).toString("base64");
  } catch (err) {
    console.error(
      `\n Could not read ${path}\n   Run 'bun run make-pdfs' first to generate fixture PDFs from the .md sources.\n`,
    );
    process.exit(1);
  }
}

const billB64 = loadPdfAsBase64(BILL_PATH);
const eobB64 = loadPdfAsBase64(EOB_PATH);

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a medical billing auditor. You are shown two documents:

1. An itemized hospital bill (what the provider charged the patient and the
   insurer).
2. An EOB (Explanation of Benefits) from the patient's insurance plan (what
   was allowed, paid, denied, and what the patient's actual responsibility is).

Your job: identify every likely billing error the patient should dispute.
Common error types to look for:

- Duplicate charges (same CPT + same date billed twice).
- Upcoding or multiple mutually-exclusive E/M codes billed for a single visit
  (e.g. both 99284 and 99285 for the same ER encounter).
- Unbundling: charges billed separately that should be included in a facility
  fee or procedure (surgical trays, standard supplies, non-prescription meds).
- Balance billing: the provider billing the patient for more than the EOB's
  stated "patient responsibility," especially from in-network providers.
- Charges appearing on the bill but explicitly denied or not submitted per
  the EOB.
- Overcharges vs reasonable benchmark pricing.

For each error, state:
- Which line(s) on the bill, by line number and verbatim quote of the line.
- What type of error it is.
- Evidence (what on the EOB or elsewhere shows this is wrong).
- Estimated dollars the patient should not owe.

At the end, give a total estimated reduction. Then: a one-sentence summary.

Be specific. Do not hedge. Do not invent line items that are not on the bill —
if you cite a line, quote it. If you are not sure, say so rather than guess.`;

const USER_PROMPT = `Audit this bill against the EOB. List every error you find
with line-level citations and dollar impact.`;

console.log(" Calling Claude...\n");
const t0 = Date.now();

const response = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 4096,
  system: SYSTEM_PROMPT,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: billB64 },
          title: "Itemized Hospital Bill",
          context:
            "This is what the hospital charged. Treat every line number as referenceable.",
        },
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: eobB64 },
          title: "Insurance EOB",
          context:
            "This is what the insurer allowed, paid, and calculated as patient responsibility.",
        },
        { type: "text", text: USER_PROMPT },
      ],
    },
  ],
});

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log("─".repeat(72));
for (const block of response.content) {
  if (block.type === "text") {
    console.log(block.text);
  }
}
console.log("─".repeat(72));
console.log(
  `  ${elapsed}s   in=${response.usage.input_tokens} out=${response.usage.output_tokens}   stop=${response.stop_reason}`,
);

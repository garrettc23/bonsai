/**
 * Day 2 harness — runs the structured analyzer against a fixture and
 * prints a human-readable report. Fails with exit code 1 if any grounding
 * failures occurred so CI can catch model drift.
 *
 * Usage:
 *   bun run day2                       # defaults to bill-001/eob-001
 *   bun run day2 bill-002 eob-002      # override fixture names
 */
import "../src/env.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/analyzer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

const billName = process.argv[2] ?? "bill-001";
const eobName = process.argv[3] ?? "eob-001";

const billPdfPath = join(FIXTURES_DIR, `${billName}.pdf`);
const eobPdfPath = join(FIXTURES_DIR, `${eobName}.pdf`);

console.log(`Bonsai analyzer — ${billName}.pdf vs ${eobName}.pdf\n`);

const result = await analyze({
  billPdfPath,
  eobPdfPath,
  billFixtureName: billName,
});

// Human-readable report.
const rule = "─".repeat(72);
console.log(rule);
console.log(`Summary`);
console.log(rule);
console.log(`  ${result.summary.headline}`);
console.log(``);
console.log(`  High-confidence total:   $${result.summary.high_confidence_total.toFixed(2)}`);
console.log(`  Worth-reviewing total:   $${result.summary.worth_reviewing_total.toFixed(2)}`);
console.log(`  Bill total disputed:     $${result.summary.bill_total_disputed.toFixed(2)}`);
console.log(``);

const high = result.errors.filter((e) => e.confidence === "high");
const worth = result.errors.filter((e) => e.confidence === "worth_reviewing");

if (high.length) {
  console.log(rule);
  console.log(`HIGH-CONFIDENCE ERRORS (${high.length}) — will be sent to billing dept`);
  console.log(rule);
  for (const [i, e] of high.entries()) {
    console.log(`  ${i + 1}. [${e.error_type}]${e.cpt_code ? ` CPT ${e.cpt_code}` : ""} — $${e.dollar_impact.toFixed(2)}`);
    console.log(`     Quote: "${e.line_quote.slice(0, 90)}${e.line_quote.length > 90 ? "..." : ""}"`);
    console.log(`     Evidence: ${e.evidence.slice(0, 110)}${e.evidence.length > 110 ? "..." : ""}`);
    console.log(``);
  }
}

if (worth.length) {
  console.log(rule);
  console.log(`WORTH REVIEWING (${worth.length}) — surfaced in UI, not sent to billing dept`);
  console.log(rule);
  for (const [i, e] of worth.entries()) {
    console.log(`  ${i + 1}. [${e.error_type}]${e.cpt_code ? ` CPT ${e.cpt_code}` : ""} — $${e.dollar_impact.toFixed(2)}`);
    console.log(`     Quote: "${e.line_quote.slice(0, 90)}${e.line_quote.length > 90 ? "..." : ""}"`);
    console.log(``);
  }
}

if (result.grounding_failures.length) {
  console.log(rule);
  console.log(`GROUNDING FAILURES (${result.grounding_failures.length}) — these were rejected, not reported to user`);
  console.log(rule);
  for (const [i, f] of result.grounding_failures.entries()) {
    console.log(`  ${i + 1}. ${f.reason}`);
  }
  console.log(``);
}

console.log(rule);
console.log(
  `  ${(result.meta.elapsed_ms / 1000).toFixed(1)}s   ` +
    `in=${result.meta.input_tokens} out=${result.meta.output_tokens}   ` +
    `turns=${result.meta.tool_turns}   ` +
    `errors=${result.errors.length} failures=${result.grounding_failures.length}`,
);
console.log(rule);

// Fail CI if any grounding failures snuck through — tells us the prompt
// needs tuning.
if (result.grounding_failures.length > 0) {
  console.error(`\n  ${result.grounding_failures.length} grounding failure(s). See above.`);
  process.exit(1);
}
if (result.errors.length === 0) {
  console.error(`\n  No errors reported. Either the bill is clean or the prompt is broken.`);
  process.exit(1);
}

/**
 * Day 3 harness — runs the analyzer end-to-end and generates an appeal letter.
 *
 * Writes the letter markdown to out/appeal-{billName}.md and prints a summary
 * to stdout. Fails loudly if the analyzer returned no HIGH-confidence errors
 * (there's no appeal to send) or if the letter has critical placeholders
 * like PROVIDER NAME or BILLING ADDRESS — those block mailing.
 *
 * Usage:
 *   bun run day3                       # defaults to bill-001/eob-001
 *   bun run day3 bill-002 eob-002
 */
import "../src/env.ts";
import { validateRequiredEnv } from "../src/env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/analyzer.ts";
import { generateAppealLetter } from "../src/appeal-letter.ts";
import { loadFixtureAnalyzeInput } from "../src/lib/fixture-audit.ts";

validateRequiredEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "out");

const billName = process.argv[2] ?? "bill-001";
const eobName = process.argv[3] ?? "eob-001";

console.log(`Bonsai appeal letter — ${billName}.pdf vs ${eobName}.pdf\n`);

const result = await analyze(await loadFixtureAnalyzeInput(billName, eobName));

const rule = "─".repeat(72);
console.log(rule);
console.log("Analyzer summary");
console.log(rule);
console.log(`  ${result.summary.headline}`);
console.log(`  HIGH total: $${result.summary.high_confidence_total.toFixed(2)}  errors=${result.errors.length}  turns=${result.meta.tool_turns}`);
console.log("");

console.log(rule);
console.log("Bill metadata (nulls → placeholders in letter)");
console.log(rule);
for (const [k, v] of Object.entries(result.metadata)) {
  const status = v == null ? "∅ MISSING" : "✓";
  console.log(`  ${status}  ${k.padEnd(28)} ${v ?? ""}`);
}
console.log("");

const high = result.errors.filter((e) => e.confidence === "high");
if (high.length === 0) {
  console.error("No HIGH-confidence errors. No appeal letter to generate.");
  process.exit(1);
}

const letter = generateAppealLetter(result);
mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `appeal-${billName}.md`);
writeFileSync(outPath, letter.markdown, "utf8");

console.log(rule);
console.log(`Appeal letter written to ${outPath}`);
console.log(rule);
console.log(`  Subject: ${letter.subject}`);
console.log(`  Defensible total: $${letter.defensible_total.toFixed(2)}`);
if (letter.used_placeholders.length) {
  console.log(`  Placeholders to fill before sending (${letter.used_placeholders.length}):`);
  for (const p of letter.used_placeholders) console.log(`    - ${p}`);
} else {
  console.log(`  No placeholders — letter is ready to send.`);
}
console.log("");

console.log(rule);
console.log("Letter preview (first 40 lines)");
console.log(rule);
for (const line of letter.markdown.split("\n").slice(0, 40)) {
  console.log(`  ${line}`);
}
console.log("  ...");
console.log(rule);

// Hard-fail gate: if PROVIDER NAME or BILLING ADDRESS is a placeholder, the
// letter can't be mailed — that's a critical failure of the analyzer's
// metadata extraction, not a user-fill-in.
const criticalMissing = letter.used_placeholders.filter((p) =>
  ["PROVIDER NAME", "BILLING ADDRESS", "CLAIM NUMBER"].includes(p),
);
if (criticalMissing.length) {
  console.error(`\nCRITICAL placeholders unfilled: ${criticalMissing.join(", ")}.`);
  console.error("The analyzer should have extracted these. Check the prompt.");
  process.exit(2);
}

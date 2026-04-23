/**
 * Full Bonsai end-to-end pipeline — CLI.
 *
 *   bun run bonsai                                  # bill-001/eob-001, auto
 *   bun run bonsai bill-001 eob-001 email
 *   bun run bonsai bill-001 eob-001 voice hostile
 *
 * Channel: email | voice | auto (default auto, uses heuristic).
 * Persona (optional): the simulated billing-dept persona for the chosen channel.
 */
import "../src/env.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBonsai, type Channel } from "../src/orchestrator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIXTURES_DIR = join(ROOT, "fixtures");
const OUT_DIR = join(ROOT, "out");

const billName = process.argv[2] ?? "bill-001";
const eobName = process.argv[3] ?? "eob-001";
const channel = (process.argv[4] as Channel) ?? "auto";
const persona = process.argv[5];

console.log(`Bonsai end-to-end — ${billName}/${eobName} channel=${channel}${persona ? ` persona=${persona}` : ""}\n`);

const report = await runBonsai({
  billPdfPath: join(FIXTURES_DIR, `${billName}.pdf`),
  eobPdfPath: join(FIXTURES_DIR, `${eobName}.pdf`),
  billFixtureName: billName,
  channel,
  email_persona: persona as any,
  voice_persona: persona as any,
});

const rule = "─".repeat(72);
console.log(rule);
console.log("Analyzer");
console.log(rule);
console.log(`  ${report.analyzer.summary.headline}`);
console.log(`  HIGH=$${report.analyzer.summary.high_confidence_total.toFixed(2)}  errors=${report.analyzer.errors.length}`);
console.log("");

console.log(rule);
console.log("Strategy");
console.log(rule);
console.log(`  Channel: ${report.strategy.chosen.toUpperCase()}`);
console.log(`  Reason:  ${report.strategy.reason}`);
console.log("");

if (report.email_thread) {
  console.log(rule);
  console.log(`Email negotiation — thread ${report.email_thread.thread_id}`);
  console.log(rule);
  for (const msg of report.email_thread.messages) {
    const arrow = msg.role === "outbound" ? "→ US" : "← THEM";
    console.log(`\n  [${arrow}] ${msg.ts}  "${msg.subject}"`);
    for (const line of msg.body.split("\n").slice(0, 8)) console.log(`     │ ${line}`);
    if (msg.body.split("\n").length > 8) console.log(`     │ ...`);
  }
  console.log("");
}

if (report.voice_call) {
  console.log(rule);
  console.log(`Voice call — ${report.voice_call.call_id}`);
  console.log(rule);
  for (const item of report.voice_call.transcript) {
    if (item.who === "agent") console.log(`\n[Agent] ${item.text}`);
    else if (item.who === "rep") console.log(`\n[Rep]   ${item.text}`);
    else console.log(`[tool]  ${item.text}`);
  }
  console.log("");
}

console.log(rule);
console.log("Summary");
console.log(rule);
console.log(`  Original balance:    $${report.summary.original_balance.toFixed(2)}`);
console.log(`  Defensibly disputed: $${report.summary.defensible_disputed.toFixed(2)}`);
console.log(`  Final balance:       ${report.summary.final_balance == null ? "(unresolved)" : "$" + report.summary.final_balance.toFixed(2)}`);
console.log(`  Patient saved:       ${report.summary.patient_saved == null ? "(unresolved)" : "$" + report.summary.patient_saved.toFixed(2)}`);
console.log(`  Channel used:        ${report.summary.channel_used}`);
console.log(`  Outcome:             ${report.summary.outcome}`);
console.log(`  Detail:              ${report.summary.outcome_detail}`);
console.log(rule);

// Write a stable copy for UI / debugging.
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, `report-${billName}.json`), JSON.stringify(report, null, 2), "utf8");
console.log(`\nFull report JSON: out/report-${billName}.json`);

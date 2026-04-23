/**
 * Day 5 harness — simulated voice call.
 *
 * Runs two Claude conversations against each other:
 *   - Agent uses the EXACT system prompt + tools that ElevenLabs will use.
 *   - Rep role-plays a hospital billing-dept rep (persona selectable).
 *
 * This validates the agent design without burning Twilio minutes.
 *
 * Usage:
 *   bun run day5                                     # cooperative persona
 *   bun run day5 bill-001 eob-001 stall_then_concede
 *   bun run day5 bill-001 eob-001 hostile
 *   bun run day5 bill-001 eob-001 voicemail
 */
import "../src/env.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/analyzer.ts";
import { simulateCall, type RepPersona } from "../src/voice/simulator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

const billName = process.argv[2] ?? "bill-001";
const eobName = process.argv[3] ?? "eob-001";
const persona = (process.argv[4] as RepPersona) ?? "cooperative";

console.log(`Bonsai voice call simulator — ${billName}/${eobName} rep=${persona}\n`);

const analyzer = await analyze({
  billPdfPath: join(FIXTURES_DIR, `${billName}.pdf`),
  eobPdfPath: join(FIXTURES_DIR, `${eobName}.pdf`),
  billFixtureName: billName,
});

console.log(`Analyzer: ${analyzer.summary.headline}`);
console.log(`  HIGH=$${analyzer.summary.high_confidence_total.toFixed(2)} errors=${analyzer.errors.length}\n`);

const { call_id, state, transcript } = await simulateCall({
  analyzer,
  persona,
  max_turns: 12,
});

console.log(`\n─── Call ${call_id} ─────────────────────────────────`);
for (const item of transcript) {
  if (item.who === "agent") {
    console.log(`\n[Agent] ${item.text}`);
  } else if (item.who === "rep") {
    console.log(`\n[Rep]   ${item.text}`);
  } else {
    console.log(`[tool]  ${item.text}`);
  }
}

console.log(`\n─── Outcome ─────────────────────────────────`);
console.log(`Status: ${state.outcome.status}`);
if (state.outcome.negotiated_amount != null) {
  console.log(`Negotiated amount: $${state.outcome.negotiated_amount.toFixed(2)}`);
}
if (state.outcome.commitment_notes) {
  console.log(`Notes: ${state.outcome.commitment_notes}`);
}
if (state.outcome.handoff_reason) {
  console.log(`Handoff reason: ${state.outcome.handoff_reason}`);
}
console.log(`\nTool events: ${state.tool_events.length}`);
console.log(`Transcript: out/calls/${call_id}.transcript.md`);
console.log(`State:      out/calls/${call_id}.json`);

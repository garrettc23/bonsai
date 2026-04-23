/**
 * Day 4 harness — full email negotiation, fully simulated.
 *
 * Pipeline:
 *   1. Analyze bill + EOB (same as Day 2/3).
 *   2. Start negotiation: send initial appeal letter to a mock inbox.
 *   3. Loop: simulate a billing-dept reply → run stepNegotiation → check state.
 *   4. Stop when resolved or escalated, or after MAX_ROUNDS.
 *
 * Persona defaults to stall_then_concede — exercises the most code paths
 * (stall, partial concession with balance billing pushback, full concession
 * after NSA citation).
 *
 * Usage:
 *   bun run day4                          # bill-001/eob-001, stall_then_concede
 *   bun run day4 bill-001 eob-001 hostile # forces escalation
 */
import "../src/env.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/analyzer.ts";
import { MockEmailClient, loadThread } from "../src/clients/email-mock.ts";
import {
  startNegotiation,
  stepNegotiation,
  saveNegotiationState,
  type NegotiationState,
  type NegotiationOutcome,
} from "../src/negotiate-email.ts";
import { simulateReply, type Persona } from "../src/simulate-reply.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

const billName = process.argv[2] ?? "bill-001";
const eobName = process.argv[3] ?? "eob-001";
const persona = (process.argv[4] as Persona) ?? "stall_then_concede";

const MAX_ROUNDS = 5;

const PATIENT_EMAIL = "jane.doe@example.com";
const PROVIDER_EMAIL = "billing@stsyntheticregional.example.com";

console.log(`Bonsai email negotiation — ${billName}/${eobName} persona=${persona}\n`);

const analyzer = await analyze({
  billPdfPath: join(FIXTURES_DIR, `${billName}.pdf`),
  eobPdfPath: join(FIXTURES_DIR, `${eobName}.pdf`),
  billFixtureName: billName,
});

console.log(`Analyzer: ${analyzer.summary.headline}`);
console.log(`  HIGH=$${analyzer.summary.high_confidence_total.toFixed(2)} errors=${analyzer.errors.length}\n`);

const high = analyzer.errors.filter((e) => e.confidence === "high");
if (high.length === 0) {
  console.error("No HIGH-confidence errors. Nothing to negotiate.");
  process.exit(1);
}

const client = new MockEmailClient();
const { thread_id, sent, state: initialState } = await startNegotiation({
  analyzer,
  client,
  patient_email: PATIENT_EMAIL,
  provider_email: PROVIDER_EMAIL,
});

console.log(`Thread ${thread_id} started.`);
console.log(`→ Sent initial appeal. subject="${sent.subject}"\n`);

let state: NegotiationState = initialState;
saveNegotiationState(state);

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`\n─── Round ${round} ─────────────────────────────────`);

  // 1) Billing dept sends a reply.
  const thread = loadThread(thread_id);
  const latestOutbound = thread.outbound[thread.outbound.length - 1];
  const latestSubject = latestOutbound?.subject ?? "";

  console.log(`[simulator] billing dept drafting reply (turn ${round}, persona=${persona})...`);
  const replyBody = await simulateReply({
    thread_id,
    turn_number: round,
    persona,
    analyzer,
    provider_email: PROVIDER_EMAIL,
    patient_email: PATIENT_EMAIL,
    reply_to_subject: latestSubject,
    latest_outbound_body: latestOutbound?.body_markdown ?? "",
    client,
  });
  console.log(`[simulator] inbound reply:\n`);
  for (const line of replyBody.split("\n").slice(0, 18)) console.log(`  │ ${line}`);
  if (replyBody.split("\n").length > 18) console.log(`  │ ...`);

  // 2) Negotiator processes.
  console.log(`\n[negotiator] processing inbound...`);
  state = await stepNegotiation({ state, client });
  saveNegotiationState(state);

  const newThread = loadThread(thread_id);
  if (newThread.outbound.length > (round === 1 ? 1 : round)) {
    const out = newThread.outbound[newThread.outbound.length - 1];
    console.log(`[negotiator] → sent reply. subject="${out.subject}"\n`);
    for (const line of out.body_markdown.split("\n").slice(0, 18)) console.log(`  │ ${line}`);
    if (out.body_markdown.split("\n").length > 18) console.log(`  │ ...`);
  }

  if (state.outcome.status !== "in_progress") break;
}

console.log(`\n─── Final state ─────────────────────────────────`);
console.log(`Thread id: ${thread_id}`);
console.log(`Outcome: ${JSON.stringify(state.outcome, null, 2)}`);
const final = loadThread(thread_id);
console.log(`\nMessages exchanged: ${final.outbound.length} outbound + ${final.inbound.length} inbound`);
console.log(`Thread on disk: out/threads/${thread_id}.json`);
console.log(`State on disk:  out/threads/${thread_id}.state.json`);

if (state.outcome.status === "resolved") {
  const o = state.outcome as Extract<NegotiationOutcome, { status: "resolved" }>;
  console.log(`\n✓ RESOLVED: ${o.resolution}. Patient owes $${o.final_amount_owed.toFixed(2)}.`);
  console.log(`  Notes: ${o.notes}`);
  process.exit(0);
}
if (state.outcome.status === "escalated") {
  const o = state.outcome as Extract<NegotiationOutcome, { status: "escalated" }>;
  console.log(`\n⚠ ESCALATED: ${o.reason}. ${o.notes}`);
  process.exit(0);
}
console.log(`\n⋯ Still in progress after ${MAX_ROUNDS} rounds. Would continue in production.`);
process.exit(0);

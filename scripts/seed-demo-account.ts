#!/usr/bin/env bun
/**
 * Seed a polished demo account for live presentations.
 *
 * Creates (or reuses) the account `gcgeester04@gmail.com` and fills it with
 * realistic, hand-authored fake data covering every Bonsai use case:
 *   - 5 bill negotiations across categories (medical / telecom / utility /
 *     insurance / financial) with a mix of completed wins, one in-progress
 *     negotiation, and one awaiting-approval audit.
 *   - 7 comparison / offer hunts (car insurance, internet, mobile, electricity,
 *     prescription, mortgage refi, credit card).
 *
 * The account is created as a password user. The demo logs in with **Google
 * OAuth**: `handleGoogleCallback` links the Google identity to the existing
 * account by matching email (`linkGoogleSub`), so all data seeded here shows
 * up after sign-in.
 *
 * Writes only static content — no LLM / network calls. Fully deterministic and
 * idempotent: re-running wipes this one account's artifacts and reseeds.
 *
 * Run **inside** the deployed container so writes land on the Railway volume
 * ($BONSAI_DATA_DIR):  railway ssh -- bun run scripts/seed-demo-account.ts
 * Locally:  BONSAI_DATA_DIR=$(mktemp -d) bun run scripts/seed-demo-account.ts
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createUser, getUserByEmail, type User } from "../src/lib/auth.ts";
import { getDb } from "../src/lib/db.ts";
import { ensureUserDirs, userPaths, type UserPaths } from "../src/lib/user-paths.ts";
import { withUserContext } from "../src/lib/user-context.ts";
import { setProfileConfig } from "../src/lib/user-settings.ts";

import type { AnalyzerResult, BillContact, BillingError } from "../src/types.ts";
import type { BonsaiReport, ThreadMessage } from "../src/orchestrator.ts";
import type { NegotiationState } from "../src/negotiate-email.ts";
import type { CallState } from "../src/voice/tool-handlers.ts";
import type { Baseline, OfferHuntResult, OfferRecord } from "../src/offer-agent.ts";

const DEMO_EMAIL = "gcgeester04@gmail.com";
const DEMO_PASSWORD = "BonsaiDemo!2026"; // placeholder — the demo logs in via Google OAuth.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const FIXTURES = join(REPO_ROOT, "fixtures");

// ─────────────────────────────────────────────────────────────────────────────
// Local structural type for a PendingRun. The real interface lives in
// src/server.ts (not exported, and importing server.ts would boot the HTTP
// server) — so we mirror only the fields the history / offer endpoints read.
// ─────────────────────────────────────────────────────────────────────────────
interface SeedPendingRun {
  run_id: string;
  fixture_name: string;
  bill_path: string;
  bill_paths: string[];
  bill_names: string[];
  eob_path?: string;
  eob_name?: string;
  channel: string;
  partial_report?: BonsaiReport;
  qa: Array<{ q: string; a: string; ts: string }>;
  created_at: number;
  status?: "audited" | "negotiating" | "completed" | "failed" | "cancelled";
  approved_at?: number;
  completed_at?: number;
  contact?: BillContact;
  display_name?: string;
  comparison_only?: boolean;
}

const now = Date.now();
const daysAgo = (d: number) => now - d * 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function writeJSON(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
}

function emptyAnalyzerMeta(): AnalyzerResult["meta"] {
  return { model: "claude-opus-4-7", input_tokens: 38000, output_tokens: 2100, elapsed_ms: 34210, tool_turns: 3 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bill cases. Each writes report-<name>.json (+ appeal-<name>.md when present)
// and a paired pending/<run_id>.json. The Negotiation list overlays the
// pending status onto the report row; the Results view fetches the report.
// ─────────────────────────────────────────────────────────────────────────────
interface BillCase {
  name: string;
  display_name: string;
  report: BonsaiReport;
  appeal_md?: string;
  contact: BillContact;
  channel: string;
  status: "audited" | "negotiating" | "completed";
  /** Original fixture PDFs to copy into uploads/ so the bill viewer has a doc. */
  upload_bill?: string;
  upload_eob?: string;
}

function thread(messages: ThreadMessage[]): ThreadMessage[] {
  return messages;
}

// 1) MEDICAL — hospital balance billing. COMPLETED WIN (persistent: email→voice).
function medicalCase(): BillCase {
  const errors: BillingError[] = [
    {
      line_quote: "4  03/14/2026  71046  Chest X-ray, 2 views  1  $468.00",
      page_number: 1,
      error_type: "duplicate",
      confidence: "high",
      dollar_impact: 468,
      evidence:
        "EOB 'Services Not Listed Above' notes: 'Duplicate charge for CPT 71046 — already adjudicated once.' The itemized bill lists CPT 71046 twice on 03/14/2026; the second line is a duplicate.",
      cpt_code: "71046",
    },
    {
      line_quote: "11  03/14/2026  99284  Emergency Dept Visit — Moderate  1  $1,680.00",
      page_number: 1,
      error_type: "denied_service",
      confidence: "high",
      dollar_impact: 1680,
      evidence:
        "EOB denies CPT 99284: 'Only one E/M level is payable per encounter; 99284 denied as duplicate to 99285.' Patient is not responsible per the plan.",
      cpt_code: "99284",
    },
    {
      line_quote: "14  03/14/2026  99070  Supplies and Materials  1  $1,240.00",
      page_number: 1,
      error_type: "denied_service",
      confidence: "high",
      dollar_impact: 1240,
      evidence:
        "EOB: 'CPT 99070 bundled into the facility fee per plan policy — not separately reimbursable.' Patient is not responsible.",
      cpt_code: "99070",
    },
    {
      line_quote: "Current Balance Due  $6,371.50",
      page_number: 1,
      error_type: "balance_billing",
      confidence: "high",
      dollar_impact: 3612,
      evidence:
        "EOB states 'Your Total Responsibility' is $2,759.50 for in-network St. Mercy Regional, with the warning: 'You owe no more than this amount. If billed for more, you may be a victim of balance billing.' The bill's balance of $6,371.50 exceeds that cap by $3,612 — improper balance billing under the No Surprises Act. This envelope subsumes the line findings above.",
    },
  ];
  const analyzer: AnalyzerResult = {
    metadata: {
      patient_name: "Greg Geester",
      provider_name: "St. Mercy Regional Medical Center",
      provider_billing_address: "1200 Care Plaza Drive, San Francisco, CA 94110",
      claim_number: "CL-2026-0099481",
      date_of_service: "03/14/2026",
      insurer_name: "BlueShield PPO",
      eob_patient_responsibility: 2759.5,
      bill_current_balance_due: 6371.5,
      account_number: "2045-887291",
      bill_kind: "medical",
    },
    errors,
    summary: {
      high_confidence_total: 3612,
      worth_reviewing_total: 0,
      bill_total_disputed: 3612,
      headline:
        "Found $3,612 in high-confidence balance billing by an in-network hospital — the bill charges $6,371.50 when the EOB caps your responsibility at $2,759.50.",
    },
    grounding_failures: [],
    meta: emptyAnalyzerMeta(),
  };

  const appealMd = `${iso(daysAgo(21)).slice(0, 10)}

St. Mercy Regional Medical Center
Attn: Patient Accounts
1200 Care Plaza Drive, San Francisco, CA 94110

Re: Disputed charges — Patient: Greg Geester | Account #: 2045-887291 | Claim #: CL-2026-0099481 | DOS: 03/14/2026

Dear Billing Department,

I am formally disputing $3,612.00 in charges on the account above. Comparing the itemized bill against the Explanation of Benefits from BlueShield PPO, my total patient responsibility is $2,759.50, yet the Current Balance Due is $6,371.50.

Under the federal No Surprises Act (45 CFR Part 149), an in-network provider may not bill above the patient cost-sharing the plan determines. Please correct the balance to $2,759.50, remove the disputed lines, and confirm in writing that no adverse credit action will be taken while this dispute is open.

Sincerely,
Greg Geester`;

  const appeal = {
    markdown: appealMd,
    subject: "Disputed charges — Greg Geester, Claim CL-2026-0099481",
    defensible_total: 3612,
    used_placeholders: [],
  };

  const emailState: NegotiationState = {
    thread_id: "thr_med_demo",
    analyzer,
    user_email: DEMO_EMAIL,
    provider_email: "billing@stmercyregional.example",
    final_acceptable_floor: 2759.5,
    last_seen_inbound_ts: iso(daysAgo(16)),
    outcome: {
      status: "resolved",
      resolution: "full_adjustment",
      final_amount_owed: 2759.5,
      notes: "Hospital agreed to reprice to the EOB patient-responsibility cap after the No Surprises Act citation.",
    },
  };

  const callState: CallState = {
    call_id: "call_med_demo",
    thread_id: "thr_med_demo",
    analyzer,
    final_acceptable_floor: 2759.5,
    tool_events: [],
    outcome: {
      status: "success",
      negotiated_amount: 2759.5,
      commitment_notes: "Supervisor confirmed corrected statement at $2,759.50 will mail within 10 business days.",
    },
  };

  const report: BonsaiReport = {
    analyzer,
    appeal,
    strategy: {
      chosen: "persistent",
      reason: "Both email and phone on file — emailed first, escalated to a call after no movement.",
    },
    email_thread: {
      thread_id: "thr_med_demo",
      state: emailState,
      messages: thread([
        {
          role: "outbound",
          subject: appeal.subject,
          body: appealMd,
          ts: iso(daysAgo(21)),
        },
        {
          role: "inbound",
          subject: "RE: Disputed charges — Greg Geester",
          body: "We received your dispute and are reviewing the account. A response will follow within 30 days.",
          ts: iso(daysAgo(18)),
        },
        {
          role: "outbound",
          subject: "RE: Disputed charges — Greg Geester",
          body: "Thank you. Given the EOB explicitly caps responsibility at $2,759.50 and cites balance-billing protections, please confirm the account will be repriced to that amount.",
          ts: iso(daysAgo(17)),
        },
      ]),
    },
    voice_call: {
      call_id: "call_med_demo",
      state: callState,
      transcript: [
        { who: "agent", text: "Hi, I'm an automated assistant calling on behalf of the account holder, Greg Geester, regarding account 2045-887291. This call may be recorded." },
        { who: "rep", text: "Okay, what's the issue with the account?" },
        { who: "agent", text: "The EOB from BlueShield caps patient responsibility at $2,759.50, but the balance is $6,371.50. That's $3,612 of balance billing on an in-network claim." },
        { who: "rep", text: "Let me pull the EOB… I see it. I can reprice the balance to $2,759.50 and reissue the statement." },
        { who: "tool", text: "record_negotiated_amount(amount=2759.50)" },
        { who: "agent", text: "Thank you. Please send written confirmation. Have a good day." },
      ],
      source: "simulator",
    },
    summary: {
      original_balance: 6371.5,
      defensible_disputed: 3612,
      final_balance: 2759.5,
      patient_saved: 3612,
      channel_used: "persistent",
      outcome: "resolved",
      outcome_detail: "Hospital repriced the balance to the EOB cap of $2,759.50 — $3,612 saved.",
    },
  };

  return {
    name: "demo-medical-hospital",
    display_name: "St. Mercy Regional Medical Center",
    report,
    appeal_md: appealMd,
    contact: {
      support_email: "billing@stmercyregional.example",
      support_phone: "+14155550118",
      account_holder_name: "Greg Geester",
      bill_kind: "medical",
    },
    channel: "persistent",
    status: "completed",
    upload_bill: "bill-001.pdf",
    upload_eob: "eob-001.pdf",
  };
}

// Helper to build a goodwill-mode (non-medical) report.
function goodwillReport(args: {
  provider: string;
  bill_kind: AnalyzerResult["metadata"]["bill_kind"];
  account_number: string;
  errors: BillingError[];
  original_balance: number;
  defensible: number;
  final_balance: number | null;
  patient_saved: number | null;
  channel_used: "email" | "voice" | "persistent";
  outcome: "resolved" | "escalated" | "in_progress";
  outcome_detail: string;
  headline: string;
  subject: string;
  appeal_md: string;
  email?: { state: NegotiationState; messages: ThreadMessage[] };
}): BonsaiReport {
  const analyzer: AnalyzerResult = {
    metadata: {
      patient_name: "Greg Geester",
      provider_name: args.provider,
      provider_billing_address: null,
      claim_number: null,
      date_of_service: null,
      insurer_name: null,
      eob_patient_responsibility: null,
      bill_current_balance_due: args.original_balance,
      account_number: args.account_number,
      bill_kind: args.bill_kind,
    },
    errors: args.errors,
    summary: {
      high_confidence_total: args.defensible,
      worth_reviewing_total: 0,
      bill_total_disputed: args.defensible,
      headline: args.headline,
    },
    grounding_failures: [],
    meta: emptyAnalyzerMeta(),
  };
  const report: BonsaiReport = {
    analyzer,
    appeal: {
      markdown: args.appeal_md,
      subject: args.subject,
      defensible_total: args.defensible,
      used_placeholders: [],
    },
    strategy: {
      chosen: args.channel_used,
      reason: "Email is the contact channel on file — reaching out to the support department.",
    },
    summary: {
      original_balance: args.original_balance,
      defensible_disputed: args.defensible,
      final_balance: args.final_balance,
      patient_saved: args.patient_saved,
      channel_used: args.channel_used,
      outcome: args.outcome,
      outcome_detail: args.outcome_detail,
    },
  };
  if (args.email) {
    report.email_thread = { thread_id: args.email.state.thread_id, state: args.email.state, messages: args.email.messages };
  }
  return report;
}

// 2) TELECOM — internet, expired promo restored. COMPLETED WIN.
function telecomCase(): BillCase {
  const errors: BillingError[] = [
    {
      line_quote: "Internet Service — Standard Rate  $89.99",
      page_number: 1,
      error_type: "expired_promo",
      confidence: "high",
      dollar_impact: 360,
      evidence:
        "Account signed at a $59.99/mo 24-month promo. The promo end was not communicated and the bill jumped to $89.99 — a $30/mo increase. Restoring the agreed rate for 12 months recovers $360.",
    },
  ];
  const appealMd = `Hello,

I'm writing about account 8829-114. My 24-month promotional rate of $59.99/mo lapsed without notice and the bill is now $89.99/mo. As a long-standing customer in good standing, I'd like the promotional rate restored. Please reinstate $59.99/mo and credit the difference.

Thank you,
Greg Geester`;
  const state: NegotiationState = {
    thread_id: "thr_telecom_demo",
    analyzer: {} as AnalyzerResult, // not read by the UI for the thread tab
    user_email: DEMO_EMAIL,
    provider_email: "care@brightband.example",
    final_acceptable_floor: 0,
    last_seen_inbound_ts: iso(daysAgo(9)),
    outcome: {
      status: "resolved",
      resolution: "reduced",
      final_amount_owed: 0,
      notes: "Promo rate restored at $59.99/mo for 12 months plus a $30 one-time courtesy credit.",
    },
  };
  const report = goodwillReport({
    provider: "BrightBand Internet",
    bill_kind: "telecom",
    account_number: "8829-114",
    errors,
    original_balance: 360,
    defensible: 360,
    final_balance: 0,
    patient_saved: 360,
    channel_used: "email",
    outcome: "resolved",
    outcome_detail: "Promo rate restored at $59.99/mo for 12 months — $360 saved over the year.",
    headline: "Your $59.99 promo lapsed without notice; restoring it for 12 months recovers $360.",
    subject: "Promotional rate restoration — account 8829-114",
    appeal_md: appealMd,
    email: {
      state,
      messages: thread([
        { role: "outbound", subject: "Promotional rate restoration — account 8829-114", body: appealMd, ts: iso(daysAgo(12)) },
        { role: "inbound", subject: "RE: Promotional rate restoration", body: "Thanks for reaching out — we value your loyalty. I've reapplied the $59.99 rate for 12 months and added a $30 courtesy credit to your next statement.", ts: iso(daysAgo(9)) },
      ]),
    },
  });
  // Strip the placeholder analyzer object from the embedded thread state on disk.
  report.email_thread!.state.analyzer = report.analyzer;
  return {
    name: "demo-telecom-internet",
    display_name: "BrightBand Internet",
    report,
    contact: { support_email: "care@brightband.example", account_holder_name: "Greg Geester", bill_kind: "telecom" },
    channel: "email",
    status: "completed",
  };
}

// 3) UTILITY — electricity, late fee + duplicate charge reversed. COMPLETED WIN.
function utilityCase(): BillCase {
  const errors: BillingError[] = [
    {
      line_quote: "Late Payment Charge  $35.00",
      page_number: 1,
      error_type: "fee_waiver",
      confidence: "worth_reviewing",
      dollar_impact: 35,
      evidence: "A single late payment after years of on-time history is routinely waivable as a one-time courtesy.",
    },
    {
      line_quote: "Meter Service Charge  $40.00",
      page_number: 1,
      error_type: "duplicate",
      confidence: "high",
      dollar_impact: 40,
      evidence: "The meter service charge appears twice on this statement — the second instance is a duplicate.",
    },
  ];
  const appealMd = `Hello,

Regarding account 553-201: my statement includes a $35 late fee (my first in years of on-time payments) and a duplicated $40 meter service charge. Please waive the late fee as a one-time courtesy and remove the duplicate charge.

Thank you,
Greg Geester`;
  const state: NegotiationState = {
    thread_id: "thr_utility_demo",
    analyzer: {} as AnalyzerResult,
    user_email: DEMO_EMAIL,
    provider_email: "support@valleypower.example",
    final_acceptable_floor: 0,
    last_seen_inbound_ts: iso(daysAgo(5)),
    outcome: { status: "resolved", resolution: "reduced", final_amount_owed: 0, notes: "Late fee waived and duplicate meter charge removed — $75 credited." },
  };
  const report = goodwillReport({
    provider: "Valley Power & Electric",
    bill_kind: "utility",
    account_number: "553-201",
    errors,
    original_balance: 75,
    defensible: 40,
    final_balance: 0,
    patient_saved: 75,
    channel_used: "email",
    outcome: "resolved",
    outcome_detail: "Late fee waived and duplicate meter charge removed — $75 credited.",
    headline: "A $35 late fee and a duplicated $40 meter charge — both reversible.",
    subject: "Billing correction — account 553-201",
    appeal_md: appealMd,
    email: {
      state,
      messages: thread([
        { role: "outbound", subject: "Billing correction — account 553-201", body: appealMd, ts: iso(daysAgo(7)) },
        { role: "inbound", subject: "RE: Billing correction", body: "Thanks Greg — I've waived the $35 late fee and removed the duplicate $40 charge. A $75 credit will appear on your next bill.", ts: iso(daysAgo(5)) },
      ]),
    },
  });
  report.email_thread!.state.analyzer = report.analyzer;
  return {
    name: "demo-utility-electric",
    display_name: "Valley Power & Electric",
    report,
    contact: { support_email: "support@valleypower.example", account_holder_name: "Greg Geester", bill_kind: "utility" },
    channel: "email",
    status: "completed",
  };
}

// 4) INSURANCE — auto policy mid-term surcharge dispute. NEGOTIATING (in progress).
function insuranceCase(): BillCase {
  const errors: BillingError[] = [
    {
      line_quote: "Mid-term Premium Adjustment — Surcharge  $214.00",
      page_number: 1,
      error_type: "unauthorized_charge",
      confidence: "high",
      dollar_impact: 214,
      evidence:
        "A $214 mid-term surcharge was applied citing a 'driving record event' that does not appear on the policyholder's record. No notice or explanation was provided before the charge.",
    },
  ];
  const appealMd = `Hello,

Re: auto policy GA-77-4412. A $214 mid-term surcharge was added citing a driving-record event I have no record of and was never notified about. Please provide the basis for this surcharge or reverse it.

Thank you,
Greg Geester`;
  const state: NegotiationState = {
    thread_id: "thr_insurance_demo",
    analyzer: {} as AnalyzerResult,
    user_email: DEMO_EMAIL,
    provider_email: "service@summitauto.example",
    final_acceptable_floor: 0,
    last_seen_inbound_ts: iso(daysAgo(2)),
    last_inbound_received_at: iso(daysAgo(2)),
    outcome: { status: "in_progress" },
  };
  const report = goodwillReport({
    provider: "Summit Auto Insurance",
    bill_kind: "insurance",
    account_number: "GA-77-4412",
    errors,
    original_balance: 214,
    defensible: 214,
    final_balance: null,
    patient_saved: null,
    channel_used: "email",
    outcome: "in_progress",
    outcome_detail: "Dispute sent; carrier acknowledged and is reviewing the surcharge.",
    headline: "A $214 mid-term surcharge with no matching driving record — disputing it now.",
    subject: "Surcharge dispute — policy GA-77-4412",
    appeal_md: appealMd,
    email: {
      state,
      messages: thread([
        { role: "outbound", subject: "Surcharge dispute — policy GA-77-4412", body: appealMd, ts: iso(daysAgo(3)) },
        { role: "inbound", subject: "RE: Surcharge dispute", body: "We've received your inquiry and opened a review of the surcharge. Please allow 7–10 business days for our underwriting team to respond.", ts: iso(daysAgo(2)) },
      ]),
    },
  });
  report.email_thread!.state.analyzer = report.analyzer;
  return {
    name: "demo-insurance-auto",
    display_name: "Summit Auto Insurance",
    report,
    contact: { support_email: "service@summitauto.example", account_holder_name: "Greg Geester", bill_kind: "insurance" },
    channel: "email",
    status: "negotiating",
  };
}

// 5) FINANCIAL — credit card fees. AWAITING APPROVAL (audited, not yet sent).
function financialCase(): BillCase {
  const errors: BillingError[] = [
    {
      line_quote: "Annual Membership Fee  $95.00",
      page_number: 1,
      error_type: "unauthorized_charge",
      confidence: "high",
      dollar_impact: 95,
      evidence:
        "The $95 annual fee was charged despite a retention offer on file that waived the annual fee for the upcoming year. The waiver was not applied.",
    },
    {
      line_quote: "Late Payment Fee  $39.00",
      page_number: 1,
      error_type: "fee_waiver",
      confidence: "worth_reviewing",
      dollar_impact: 39,
      evidence: "First late payment in the account history — eligible for a one-time courtesy waiver.",
    },
  ];
  const appealMd = `Hello,

Re: card account ending 4417. Two items to correct:
1. A $95 annual membership fee was charged even though a retention offer waiving it for this year is on my account.
2. A $39 late fee — my first ever — which I'm requesting be waived as a one-time courtesy.

Please reverse the $95 fee per the waiver on file and waive the $39 late fee.

Thank you,
Greg Geester`;
  const report = goodwillReport({
    provider: "Meridian Card Services",
    bill_kind: "financial",
    account_number: "****4417",
    errors,
    original_balance: 134,
    defensible: 95,
    final_balance: null,
    patient_saved: null,
    channel_used: "email",
    outcome: "in_progress",
    outcome_detail: "Audit complete — awaiting your approval to send the dispute.",
    headline: "A $95 annual fee charged against a waiver on file, plus a waivable $39 late fee.",
    subject: "Fee reversal request — account ending 4417",
    appeal_md: appealMd,
  });
  return {
    name: "demo-financial-creditcard",
    display_name: "Meridian Card Services",
    report,
    appeal_md: appealMd,
    contact: { support_email: "cardservices@meridian.example", account_holder_name: "Greg Geester", bill_kind: "financial" },
    channel: "email",
    status: "audited",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison / offer hunts. Each writes offers/<ts>-<run_id>-<slug>.json with a
// run_id, plus a comparison_only pending/<run_id>.json so the Comparison view
// (which filters offers to active run_ids) lists it.
// ─────────────────────────────────────────────────────────────────────────────
interface ComparisonCase {
  baseline: Baseline;
  offers: OfferRecord[];
  best_provider: string;
  outcome: OfferHuntResult["outcome"];
  headline: string;
  total_monthly_savings: number | null;
}

function comparisonCases(): ComparisonCase[] {
  return [
    {
      baseline: { label: "Auto insurance — Summit Auto", category: "car_insurance", current_provider: "Summit Auto Insurance", current_price: 192, cadence: "monthly premium", specifics: "100/300 liability, $500 deductible, full coverage", region: "San Francisco, CA" },
      offers: [
        { provider: "Root Insurance", price_usd: 148, terms_url: "https://www.joinroot.com", notes: "Identical 100/300 liability and $500 deductible, plus a usage-based discount and no annual contract — a clean like-for-like swap.", recommended: true, savings_vs_baseline: 44, switching_friction: "low", confidence: 0.86, equivalence: { keeps: ["100/300 liability", "$500 deductible", "full coverage"], gives_up: [], gains: ["usage-based discount", "no annual contract"], parity_score: 0.95 }, net_value_score: 41 },
        { provider: "Metromile", price_usd: 132, terms_url: "https://www.metromile.com", recommended: false, savings_vs_baseline: 60, switching_friction: "medium", confidence: 0.7, equivalence: { keeps: ["100/300 liability"], gives_up: ["pay-per-mile penalizes long commutes"], gains: [], parity_score: 0.78 }, net_value_score: 28 },
      ],
      best_provider: "Root Insurance",
      outcome: "lower_price_found",
      headline: "Found Root at $148/mo vs your $192 — same coverage, saves $44/mo.",
      total_monthly_savings: 44,
    },
    {
      baseline: { label: "Home internet — BrightBand", category: "internet", current_provider: "BrightBand Internet", current_price: 89.99, cadence: "monthly", specifics: "300 Mbps, no data cap", region: "San Francisco, CA" },
      offers: [
        { provider: "Sonic Fiber", price_usd: 49.99, terms_url: "https://www.sonic.com", notes: "Faster (1 Gbps symmetric vs 300 Mbps), no data cap, no contract — and the price doesn't step up after a promo window.", recommended: true, savings_vs_baseline: 40, switching_friction: "medium", confidence: 0.82, equivalence: { keeps: ["no data cap"], gives_up: [], gains: ["1 Gbps symmetric", "no contract"], parity_score: 0.97 }, normalized_cost: { effective_monthly_usd: 49.99, horizon_months: 24 }, net_value_score: 38 },
        { provider: "AT&T Fiber", price_usd: 55, terms_url: "https://www.att.com/internet/fiber", recommended: false, savings_vs_baseline: 22.49, switching_friction: "medium", confidence: 0.75, normalized_cost: { effective_monthly_usd: 67.5, horizon_months: 24, promo_price_usd: 55, promo_months: 12, standard_price_usd: 80 }, equivalence: { keeps: ["no data cap", "300+ Mbps"], gives_up: [], gains: ["fiber"], parity_score: 0.9 }, net_value_score: 19 },
      ],
      best_provider: "Sonic Fiber",
      outcome: "lower_price_found",
      headline: "Found Sonic Fiber at $49.99/mo (1 Gbps) vs your $89.99 — saves $40/mo.",
      total_monthly_savings: 40,
    },
    {
      baseline: { label: "Mobile phone — Verizon", category: "mobile_phone", current_provider: "Verizon", current_price: 85, cadence: "monthly", specifics: "1 line, unlimited premium data", region: "San Francisco, CA" },
      offers: [
        { provider: "Visible (Verizon network)", price_usd: 25, terms_url: "https://www.visible.com", notes: "Runs on Verizon's own network with unlimited data and taxes included; the only trade-off is possible deprioritization at congestion.", recommended: true, savings_vs_baseline: 60, switching_friction: "low", confidence: 0.9, equivalence: { keeps: ["Verizon network", "unlimited data"], gives_up: ["data may be deprioritized at congestion"], gains: ["no contract", "taxes included"], parity_score: 0.88 }, net_value_score: 52 },
        { provider: "US Mobile", price_usd: 35, terms_url: "https://www.usmobile.com", recommended: false, savings_vs_baseline: 50, switching_friction: "low", confidence: 0.82, equivalence: { keeps: ["unlimited data", "premium network option"], gives_up: [], gains: ["multi-network choice"], parity_score: 0.9 }, net_value_score: 45 },
      ],
      best_provider: "Visible (Verizon network)",
      outcome: "lower_price_found",
      headline: "Found Visible at $25/mo on Verizon's network vs your $85 — saves $60/mo.",
      total_monthly_savings: 60,
    },
    {
      baseline: { label: "Electricity plan — Valley Power", category: "electricity", current_provider: "Valley Power & Electric", current_price: 140, cadence: "monthly average", specifics: "~667 kWh/mo at $0.21/kWh", region: "Dallas, TX" },
      offers: [
        { provider: "Gexa Energy", price_usd: 107, terms_url: "https://www.gexaenergy.com", notes: "Same usage at a fixed $0.16/kWh (vs $0.21), and it's 100% renewable — the only commitment is a 12-month term.", recommended: true, savings_vs_baseline: 33, switching_friction: "low", confidence: 0.8, equivalence: { keeps: ["same kWh usage"], gives_up: ["12-month term"], gains: ["100% renewable", "$0.16/kWh fixed"], parity_score: 0.93 }, net_value_score: 30 },
        { provider: "TXU Energy", price_usd: 120, terms_url: "https://www.txu.com", recommended: false, savings_vs_baseline: 20, switching_friction: "low", confidence: 0.78, equivalence: { keeps: ["same kWh usage"], gives_up: [], gains: ["bill-credit plan"], parity_score: 0.85 }, net_value_score: 17 },
      ],
      best_provider: "Gexa Energy",
      outcome: "lower_price_found",
      headline: "Found Gexa at $0.16/kWh (~$107/mo) vs your ~$140 — saves ~$33/mo.",
      total_monthly_savings: 33,
    },
    {
      baseline: { label: "Prescription — Atorvastatin 20mg", category: "prescription", current_provider: "Retail pharmacy (brand)", current_price: 48, cadence: "per fill", specifics: "Atorvastatin 20mg, 30-day supply", region: "San Francisco, CA" },
      offers: [
        { provider: "Mark Cuban Cost Plus Drugs", price_usd: 9, terms_url: "https://costplusdrugs.com", notes: "Exact same molecule (generic atorvastatin), same 30-day supply, at transparent cost-plus pricing — a perfect-parity switch.", recommended: true, savings_vs_baseline: 39, switching_friction: "low", confidence: 0.92, equivalence: { keeps: ["same molecule (generic atorvastatin)", "30-day supply"], gives_up: [], gains: ["transparent pricing"], parity_score: 1 }, net_value_score: 39 },
        { provider: "GoodRx (local pharmacy)", price_usd: 12, terms_url: "https://www.goodrx.com", recommended: false, savings_vs_baseline: 36, switching_friction: "low", confidence: 0.88, equivalence: { keeps: ["same molecule", "30-day supply"], gives_up: [], gains: ["pick up locally"], parity_score: 1 }, net_value_score: 36 },
      ],
      best_provider: "Mark Cuban Cost Plus Drugs",
      outcome: "lower_price_found",
      headline: "Found generic atorvastatin at $9 vs your $48 brand fill — saves $39/fill.",
      total_monthly_savings: 39,
    },
    {
      baseline: { label: "Mortgage refinance — current loan", category: "mortgage_refi", current_provider: "Heritage Home Loans", current_price: 2310, cadence: "monthly payment", specifics: "$340k balance, 6.75% fixed, 27 years remaining", region: "San Francisco, CA" },
      offers: [
        { provider: "Better Mortgage", price_usd: 2160, terms_url: "https://better.com", notes: "Drops the rate 0.875% while keeping your ~27-year payoff horizon; $4,500 in closing costs break even in 30 months.", recommended: true, savings_vs_baseline: 150, switching_friction: "high", confidence: 0.79, refi: { new_rate_pct: 5.875, new_term_months: 324, closing_costs_usd: 4500, monthly_payment_usd: 2160, break_even_months: 30, keeps_similar_term: true }, equivalence: { keeps: ["27-year payoff horizon", "fixed rate"], gives_up: [], gains: ["0.875% lower rate"], parity_score: 0.94 }, net_value_score: 26 },
        { provider: "Rocket Mortgage", price_usd: 2090, terms_url: "https://www.rocketmortgage.com", recommended: false, savings_vs_baseline: 220, switching_friction: "high", confidence: 0.7, refi: { new_rate_pct: 5.5, new_term_months: 360, closing_costs_usd: 6200, monthly_payment_usd: 2090, break_even_months: 28, keeps_similar_term: false }, equivalence: { keeps: ["fixed rate"], gives_up: ["resets clock to 30 years — more total interest"], gains: ["lowest monthly"], parity_score: 0.72 }, net_value_score: 0 },
      ],
      best_provider: "Better Mortgage",
      outcome: "lower_price_found",
      headline: "Better at 5.875% saves $150/mo with a 30-month break-even; Rocket is cheaper monthly but resets to 30 years.",
      total_monthly_savings: 150,
    },
    {
      baseline: { label: "Credit card balance — Meridian", category: "credit_card", current_provider: "Meridian Card Services", current_price: 129, cadence: "monthly interest", specifics: "$6,200 balance at 24.99% APR", region: "San Francisco, CA" },
      offers: [
        { provider: "Wells Fargo Reflect", price_usd: 10, terms_url: "https://www.wellsfargo.com/credit-cards/reflect", notes: "0% APR for 21 months halts the 24.99% interest bleed; the one-time 3% transfer fee ($186) pays for itself in under two months.", recommended: true, savings_vs_baseline: 119, switching_friction: "medium", confidence: 0.83, equivalence: { keeps: ["same balance"], gives_up: ["3% transfer fee ($186 one-time)"], gains: ["0% APR for 21 months"], parity_score: 0.9 }, normalized_cost: { effective_monthly_usd: 10, horizon_months: 21, one_time_fees_usd: 186 }, net_value_score: 110 },
        { provider: "Citi Diamond Preferred", price_usd: 12, terms_url: "https://www.citi.com", recommended: false, savings_vs_baseline: 117, switching_friction: "medium", confidence: 0.8, equivalence: { keeps: ["same balance"], gives_up: ["3% transfer fee"], gains: ["0% APR for 18 months"], parity_score: 0.88 }, normalized_cost: { effective_monthly_usd: 12, horizon_months: 18, one_time_fees_usd: 186 }, net_value_score: 104 },
      ],
      best_provider: "Wells Fargo Reflect",
      outcome: "lower_price_found",
      headline: "A 0% APR balance transfer (21 mo) cuts ~$119/mo in interest vs your 24.99% APR.",
      total_monthly_savings: 119,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
function wipeDemoArtifacts(P: UserPaths): void {
  // Top-level report-*.json / appeal-*.md
  if (existsSync(P.baseDir)) {
    for (const f of readdirSync(P.baseDir)) {
      if ((f.startsWith("report-") && f.endsWith(".json")) || (f.startsWith("appeal-") && f.endsWith(".md"))) {
        unlinkSync(join(P.baseDir, f));
      }
    }
  }
  for (const dir of [P.pendingDir, P.offersDir, P.callsDir, P.threadsDir, P.uploadsDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(`[seed] data root: ${process.env.BONSAI_DATA_DIR?.trim() || "<repo>/out"}`);

  let user: User | null = getUserByEmail(DEMO_EMAIL);
  if (user) {
    console.log(`[seed] reusing existing account ${DEMO_EMAIL} (${user.id})`);
  } else {
    user = await createUser(DEMO_EMAIL, DEMO_PASSWORD, { acceptedTerms: true });
    console.log(`[seed] created account ${DEMO_EMAIL} (${user.id})`);
  }
  if (user.email !== DEMO_EMAIL) throw new Error(`refusing to seed: resolved user email ${user.email} != ${DEMO_EMAIL}`);

  // Always (re)set the demo password so email+password sign-in works with
  // DEMO_PASSWORD — even when the account was first created via Google OAuth
  // (which stores a random hash) or by a prior seed run. Mirrors the argon2id
  // hashing the rest of auth.ts uses. Google sign-in still works in parallel:
  // the OAuth callback links by email and password login reads this hash.
  const password_hash = await Bun.password.hash(DEMO_PASSWORD, { algorithm: "argon2id" });
  getDb()
    .query("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), accepted_terms_at = COALESCE(accepted_terms_at, ?) WHERE id = ?")
    .run(password_hash, now, now, user.id);
  console.log(`[seed] password set — email+password login enabled (${DEMO_EMAIL} / ${DEMO_PASSWORD})`);

  const P = userPaths(user.id);
  wipeDemoArtifacts(P);
  ensureUserDirs(P);

  // Profile + agent authorization.
  await withUserContext(user, async () => {
    setProfileConfig({
      first_name: "Greg",
      last_name: "Geester",
      email: DEMO_EMAIL,
      phone: "+14155550142",
      address: "742 Evergreen Terrace, San Francisco, CA 94110",
      authorized: true,
      hipaa_acknowledged: true,
    });
  });

  // ── Bill cases ──
  const bills: BillCase[] = [medicalCase(), telecomCase(), utilityCase(), insuranceCase(), financialCase()];
  for (const b of bills) {
    // Copy fixture PDFs into uploads/ for cases that have a bill document.
    const billPaths: string[] = [];
    const billNames: string[] = [];
    let eobPath: string | undefined;
    let eobName: string | undefined;
    if (b.upload_bill) {
      const dest = join(P.uploadsDir, `${b.name}-bill.pdf`);
      copyFileSync(join(FIXTURES, b.upload_bill), dest);
      billPaths.push(dest);
      billNames.push("bill.pdf");
    }
    if (b.upload_eob) {
      eobPath = join(P.uploadsDir, `${b.name}-eob.pdf`);
      copyFileSync(join(FIXTURES, b.upload_eob), eobPath);
      eobName = "eob.pdf";
    }

    writeJSON(P.reportPath(b.name), b.report);
    if (b.appeal_md) writeFileSync(P.appealPath(b.name), b.appeal_md, "utf8");

    const run_id = `run_${b.name.replace(/[^a-z0-9]+/gi, "_")}`;
    const completedAt =
      b.status === "completed"
        ? daysAgo(b.name.includes("medical") ? 15 : b.name.includes("telecom") ? 9 : 5)
        : undefined;
    const pending: SeedPendingRun = {
      run_id,
      fixture_name: b.name,
      bill_path: billPaths[0] ?? "",
      bill_paths: billPaths,
      bill_names: billNames,
      eob_path: eobPath,
      eob_name: eobName,
      channel: b.channel,
      partial_report: b.report,
      qa: [],
      created_at: daysAgo(24),
      status: b.status,
      approved_at: b.status === "audited" ? undefined : daysAgo(21),
      completed_at: completedAt,
      contact: b.contact,
      display_name: b.display_name,
    };
    writeJSON(join(P.pendingDir, `${run_id}.json`), pending);
    console.log(`[seed] bill: ${b.name} (${b.status})`);
  }

  // ── Comparison / offer hunts ──
  const comparisons = comparisonCases();
  comparisons.forEach((c, i) => {
    const run_id = `run_cmp_${c.baseline.category}_${i}`;
    const best = c.offers.find((o) => o.provider === c.best_provider) ?? null;
    const result: OfferHuntResult = {
      baseline: c.baseline,
      offers: c.offers,
      best,
      outcome: c.outcome,
      headline: c.headline,
      total_monthly_savings: c.total_monthly_savings,
      started_at: iso(daysAgo(6)),
      completed_at: iso(daysAgo(6)),
      run_id,
    };
    const slug = c.baseline.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
    writeJSON(join(P.offersDir, `${now + i}-${run_id}-${slug}.json`), result);

    // Paired comparison_only pending so handleOfferHistory keeps it active.
    const pending: SeedPendingRun = {
      run_id,
      fixture_name: run_id,
      bill_path: "",
      bill_paths: [],
      bill_names: [],
      channel: "email",
      qa: [],
      created_at: daysAgo(6),
      status: "completed",
      comparison_only: true,
    };
    writeJSON(join(P.pendingDir, `${run_id}.json`), pending);
    console.log(`[seed] comparison: ${c.baseline.category} → ${c.best_provider}`);
  });

  console.log(`\n[seed] done. Account ${DEMO_EMAIL} seeded with ${bills.length} bills and ${comparisons.length} comparisons.`);
  console.log(`[seed] sign in via Google with ${DEMO_EMAIL} to view (links to this account by email).`);
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});

/**
 * Bonsai web server (Bun).
 *
 * Endpoints:
 *   GET  /                     → index.html (upload form)
 *   GET  /assets/*             → static assets
 *   POST /api/run              → multipart upload of bill.pdf + eob.pdf.
 *                                Writes them to a tmp dir, calls runBonsai,
 *                                returns the full BonsaiReport JSON.
 *   POST /api/run-fixture      → shortcut for the demo: JSON { fixture, channel }
 *                                runs against pre-shipped fixtures.
 *   GET  /api/report/:bill     → returns the last saved report for a fixture.
 *
 * This is intentionally minimalist — no auth, no rate limiting, single
 * request at a time. For a hackathon demo / local dogfood.
 */
import "./env.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  runBonsai,
  runAuditPhase,
  runNegotiationPhase,
  type Channel,
  type BonsaiReport,
} from "./orchestrator.ts";
import { normalizeBillFile, thumbnailBillBytes } from "./lib/extract-bill.ts";
import { transcribeBill } from "./lib/transcribe-bill.ts";
import { groundTruthFromText } from "./lib/ground-truth.ts";
import { extractPdfText, ScannedPdfError } from "./lib/pdf-extract.ts";
import type { AnalyzeInput } from "./lib/fixture-audit.ts";
import type { Persona as EmailPersona } from "./simulate-reply.ts";
import type { RepPersona as VoicePersona } from "./voice/simulator.ts";
import { BillContact, BillKind, hasContactChannel, type BillContact as BillContactT } from "./types.ts";
import {
  runOfferHunt,
  saveOfferHunt,
  offersDir,
  OFFER_SOURCE_DIRECTORY,
  type Baseline,
  type OfferCategory,
} from "./offer-agent.ts";
import {
  AuthError,
  clearSessionCookieHeader,
  consumePasswordResetToken,
  createPasswordResetToken,
  createSession,
  createUser,
  deleteAllSessionsForUser,
  deleteSession,
  deleteUser,
  getUserByEmail,
  getUserById,
  readSessionCookie,
  requireUser,
  setSessionCookieHeader,
  verifyCredentials,
  type User,
} from "./lib/auth.ts";
import { ensureUserDirs, userPaths, currentUserPaths } from "./lib/user-paths.ts";
import { getCurrentUser, withUserContext } from "./lib/user-context.ts";
import { getClientIp, rateLimit, rateLimitResponse } from "./lib/rate-limit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIXTURES_DIR = join(ROOT, "fixtures");
const PUBLIC_DIR = join(ROOT, "public");

function uploadDir(): string {
  return currentUserPaths().uploadsDir;
}
function pendingDir(): string {
  return currentUserPaths().pendingDir;
}
function userOutDir(): string {
  return currentUserPaths().baseDir;
}

function extensionOf(filename: string): string | null {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : null;
}

/**
 * Filesystem-safe identifier derived from an uploaded filename. Used as the
 * base for `out/report-<id>.json` and related artifacts — so it must match
 * `/[a-zA-Z0-9_-]/`. Falls back to the upload id on empty / pathological names.
 */
function safeIdFromFilename(filename: string, uploadId: string): string {
  const bare = filename.replace(/\.[^./\\]+$/, "");
  const cleaned = bare.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned.length >= 2 ? cleaned : uploadId;
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function handleRunFixture(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    fixture?: string;
    eob?: string;
    channel?: Channel;
    email_persona?: EmailPersona;
    voice_persona?: VoicePersona;
  };
  const billName = body.fixture ?? "bill-001";
  const eobName = body.eob ?? billName.replace(/^bill-/, "eob-");
  const billPdfPath = join(FIXTURES_DIR, `${billName}.pdf`);
  const eobPdfPath = join(FIXTURES_DIR, `${eobName}.pdf`);
  if (!existsSync(billPdfPath) || !existsSync(eobPdfPath)) {
    return Response.json({ error: `Fixture not found: ${billName}/${eobName}` }, { status: 404 });
  }
  const report = await runBonsai({
    billPdfPath,
    eobPdfPath,
    billFixtureName: billName,
    channel: body.channel ?? "auto",
    email_persona: body.email_persona,
    voice_persona: body.voice_persona,
  });
  const paths = currentUserPaths();
  mkdirSync(paths.reportsDir, { recursive: true });
  writeFileSync(paths.reportPath(billName), JSON.stringify(report, null, 2));
  writeFileSync(paths.appealPath(billName), report.appeal.markdown);
  return Response.json(report);
}

// ─── Phased review flow ───────────────────────────────────────────
// Split the one-shot /api/run loop into three explicit steps so the user sees
// findings, asks questions, and approves the plan before the agent reaches out.
//
//   1. POST /api/audit              → run audit only. Returns { run_id, report }.
//   2. POST /api/ask                → Q&A against the cached audit. { answer }.
//   3. POST /api/approve            → kick off negotiation using the saved audit.
//
// State is persisted to disk under out/pending/*.json keyed by run_id so that
// a page refresh between steps doesn't drop progress.

interface PendingRun {
  run_id: string;
  fixture_name: string; // the name used for final report-<name>.json output
  bill_path: string; // first uploaded file — kept for orchestrator carry-through
  bill_paths: string[]; // absolute paths of every uploaded bill page (1+)
  bill_names: string[]; // original filenames, parallel to bill_paths (for viewer labels)
  eob_path?: string;
  eob_name?: string;
  channel: Channel;
  email_persona?: EmailPersona;
  voice_persona?: VoicePersona;
  partial_report: BonsaiReport;
  plan_edits?: string; // accumulated natural-language directives for negotiation agents
  plan_chat?: Array<{ role: "user" | "assistant"; body: string; ts: string }>;
  qa: Array<{ q: string; a: string; ts: string }>;
  created_at: number;
  /**
   * Lifecycle:
   *   audited    → audit finished, user is reviewing.
   *   negotiating → user approved, background job is running the negotiation.
   *   completed  → final report written to out/report-*.json.
   *   failed     → negotiation threw. `error` field has the message.
   */
  status?: "audited" | "negotiating" | "completed" | "failed" | "cancelled";
  approved_at?: number;
  completed_at?: number;
  error?: string;
  /**
   * User feedback collected while the agent is stopped. On resume, these
   * directives get folded into the negotiation agent's system prompt so
   * the next round changes behavior per the user's notes.
   */
  feedback?: Array<{ role: "user" | "assistant"; body: string; ts: string }>;
  /** Per-run channel gating derived from feedback + tune config. */
  channels_enabled?: { email?: boolean; voice?: boolean };
  /** Per-run tone override derived from feedback + tune config. */
  agent_tone?: "polite" | "firm" | "aggressive";
  /** Per-run free-form directives from parsed feedback. */
  user_directives?: string;
  /** Explicit floor override (dollars) from UI if user set one. */
  final_acceptable_floor?: number;
  /**
   * User-entered contact info for the billing/support department. The agent
   * launch button is gated on hasContactChannel(contact) — at least one of
   * support_email or support_phone must be present. Populated by the user
   * via the drawer Contact tab; if `resolved_contact` below has populated a
   * suggestion from web search, the UI prefills these fields.
   */
  contact?: BillContactT;
  /**
   * Provider-contact resolution status. Set to "pending" when audit finishes
   * and the background lookup is in flight; populated with the result when
   * done; "failed" if the lookup threw. The user can override the resolved
   * contact via /api/contact/override before approve.
   */
  contact_status?: "pending" | "resolved" | "failed";
  contact_error?: string;
  /**
   * Web-search-grounded provider contact suggestion (from
   * `src/lib/provider-contact.ts`). Editable by the user before they hit
   * Approve. The launch gate continues to read from `contact` above —
   * `resolved_contact` is only the prefill source.
   */
  resolved_contact?: {
    email: string | null;
    phone: string | null;
    source_urls: string[];
    confidence: "high" | "medium" | "low" | "none";
    notes: string;
    /** True when the user manually edited the contact (skip future re-resolution). */
    user_edited?: boolean;
    resolved_at: number;
  };
  /**
   * Outcome verification. After a negotiation resolves, we ask the user
   * "did your next bill match?" — once they confirm, we have ground truth
   * for whether the agreed amount actually showed up. Until they verify,
   * resolved bills older than VERIFY_OUTCOME_AFTER_DAYS surface in the
   * Bills attention bucket as "verify_outcome".
   */
  outcome_verified?: "yes" | "no" | "partial";
  outcome_notes?: string;
  outcome_verified_at?: number;
  /**
   * Complaint flow only. Pre-drafted opportunity tactics produced by the
   * complaint composer at intake time, so /api/opportunities can return
   * them without a second Opus call.
   */
  complaint_opportunities?: Array<{
    title: string;
    description: string;
    dollar_estimate: number;
    icon: string;
  }>;
}

/** Days after a resolved negotiation before we nudge the user to verify. */
const VERIFY_OUTCOME_AFTER_DAYS = 21;

const MAX_BILL_FILES = 10;

function billMediaMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "pdf") return "application/pdf";
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "png") return "image/png";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "heic" || e === "heif") return "image/heic";
  if (e === "tif" || e === "tiff") return "image/tiff";
  if (e === "avif") return "image/avif";
  return "application/octet-stream";
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pendingPath(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(pendingDir(), `${safe}.json`);
}

function savePending(run: PendingRun): void {
  mkdirSync(pendingDir(), { recursive: true });
  writeFileSync(pendingPath(run.run_id), JSON.stringify(run, null, 2));
}

function loadPending(runId: string): PendingRun | null {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== runId) return null;
  const p = pendingPath(safe);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")) as PendingRun; }
  catch { return null; }
}

async function handleAudit(req: Request): Promise<Response> {
  // Per-user daily cap. Audit kicks off Opus 4.7 (operator-paid, ~$0.25–$1.00/run);
  // without a ceiling, one runaway user can drain the budget overnight.
  // Env-overridable so paid tiers / staging can lift it without a rebuild.
  const user = getCurrentUser();
  const dailyMax = Number.parseInt(process.env.BONSAI_AUDIT_DAILY_LIMIT ?? "20", 10);
  const rl = rateLimit({
    key: `audit:user:${user.id}`,
    max: Number.isFinite(dailyMax) && dailyMax > 0 ? dailyMax : 20,
    windowMs: 24 * 60 * 60 * 1000,
  });
  if (!rl.ok) {
    return rateLimitResponse(rl.retryAfterSec, "Daily limit hit, upgrade to remove.");
  }

  // Supports two body shapes:
  //   1. multipart/form-data with `bill` file (+ optional eob) → upload path
  //   2. application/json { fixture, eob?, channel? } → sample/fixture path
  const ctype = req.headers.get("content-type") ?? "";
  let billPath: string;
  let eobPath: string | undefined;
  let fixtureName: string;
  let channel: Channel = "persistent";
  let email_persona: EmailPersona | undefined;
  let voice_persona: VoicePersona | undefined;
  let analyzeInput: AnalyzeInput | undefined;
  let multipartMeta:
    | { bill_paths: string[]; bill_names: string[]; eob_name?: string }
    | undefined;

  if (ctype.includes("application/json")) {
    const body = (await req.json()) as {
      fixture?: string;
      eob?: string;
      channel?: Channel;
      email_persona?: EmailPersona;
      voice_persona?: VoicePersona;
    };
    fixtureName = body.fixture ?? "bill-001";
    const eobName = body.eob ?? fixtureName.replace(/^bill-/, "eob-");
    billPath = join(FIXTURES_DIR, `${fixtureName}.pdf`);
    eobPath = join(FIXTURES_DIR, `${eobName}.pdf`);
    if (!existsSync(billPath) || !existsSync(eobPath)) {
      return Response.json({ error: `Fixture not found: ${fixtureName}/${eobName}` }, { status: 404 });
    }
    channel = body.channel ?? "persistent";
    email_persona = body.email_persona;
    voice_persona = body.voice_persona;
  } else {
    // multipart upload — any file types. 1–N bill pages (all treated as one
    // bill, fed to the analyzer as separate content blocks). Optional EOB.
    // Normalize (HEIC→JPEG etc.), transcribe each page for grounding.
    const form = await req.formData();
    const billFiles = (form.getAll("bill") as unknown[]).filter(
      (v): v is File => v instanceof File,
    );
    const eobFile = (form.get("eob") as unknown) instanceof File
      ? (form.get("eob") as File)
      : null;
    if (billFiles.length === 0) {
      return Response.json({ error: "Missing bill file" }, { status: 400 });
    }
    if (billFiles.length > MAX_BILL_FILES) {
      return Response.json(
        { error: `Too many bill files — max ${MAX_BILL_FILES}, got ${billFiles.length}.` },
        { status: 400 },
      );
    }
    mkdirSync(uploadDir(), { recursive: true });
    const uploadId = `upload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const billPaths: string[] = [];
    const billNames: string[] = [];
    for (let i = 0; i < billFiles.length; i++) {
      const f = billFiles[i];
      const ext = extensionOf(f.name) ?? "bin";
      const p = join(uploadDir(), `${uploadId}-bill-${i + 1}.${ext}`);
      writeFileSync(p, new Uint8Array(await f.arrayBuffer()));
      billPaths.push(p);
      billNames.push(f.name);
    }
    billPath = billPaths[0];
    fixtureName = safeIdFromFilename(billFiles[0].name, uploadId);

    let eobNormalized;
    let eobName: string | undefined;
    if (eobFile) {
      const eobExt = extensionOf(eobFile.name) ?? "bin";
      eobPath = join(uploadDir(), `${uploadId}-eob.${eobExt}`);
      writeFileSync(eobPath, new Uint8Array(await eobFile.arrayBuffer()));
      eobName = eobFile.name;
      eobNormalized = await normalizeBillFile(eobPath, eobFile.name);
    }

    let billNormalizedList;
    try {
      billNormalizedList = await Promise.all(
        billPaths.map((p, i) => normalizeBillFile(p, billNames[i])),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 400 });
    }

    let transcriptJoined: string;
    try {
      const transcripts = await Promise.all(
        billNormalizedList.map((b) => transcribeBill({ bill: b, role: "bill" })),
      );
      transcriptJoined = transcripts
        .map((t, i) =>
          billNormalizedList.length === 1
            ? t
            : `\n\n--- PAGE ${i + 1} of ${billNormalizedList.length} (${billNames[i]}) ---\n\n${t}`,
        )
        .join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: `Could not read the uploaded bill: ${msg}` },
        { status: 400 },
      );
    }

    analyzeInput = {
      bill: billNormalizedList,
      eob: eobNormalized,
      billGroundTruth: groundTruthFromText(transcriptJoined, billPath),
    };

    // Stash collected metadata for the PendingRun assembled after audit.
    // Using closure-scoped vars keeps the rest of the function unchanged.
    multipartMeta = {
      bill_paths: billPaths,
      bill_names: billNames,
      eob_name: eobName,
    };

    const ch = form.get("channel");
    channel = (typeof ch === "string" && ch ? ch : "persistent") as Channel;
  }

  // Fast path: if a pre-computed audit report ships next to the fixture
  // (fixtures/<name>.report.json), skip the analyzer call entirely and
  // return the cached audit. "Try a sample" then completes in ~50ms
  // instead of ~30-45s, which is what users expect from a "demo" button.
  // Real uploads (no fixture name match) always run the live analyzer.
  const cachedReportPath = join(FIXTURES_DIR, `${fixtureName}.report.json`);
  let partial;
  if (existsSync(cachedReportPath)) {
    partial = JSON.parse(readFileSync(cachedReportPath, "utf-8"));
  } else {
    partial = await runAuditPhase({
      billPdfPath: billPath,
      eobPdfPath: eobPath,
      billFixtureName: fixtureName,
      analyzeInput,
      channel,
      email_persona,
      voice_persona,
    });
  }

  const billPaths = multipartMeta?.bill_paths ?? [billPath];
  const billNames = multipartMeta?.bill_names ?? [`${fixtureName}.pdf`];
  const eobName = multipartMeta?.eob_name ?? (eobPath ? basename(eobPath) : undefined);

  const run: PendingRun = {
    run_id: newRunId(),
    fixture_name: fixtureName,
    bill_path: billPath,
    bill_paths: billPaths,
    bill_names: billNames,
    eob_path: eobPath,
    eob_name: eobName,
    channel,
    email_persona,
    voice_persona,
    partial_report: partial,
    qa: [],
    created_at: Date.now(),
    status: "audited",
    // Pre-seed contact info for canonical fixtures so 'Try a sample' keeps
    // working with the contact gate enabled. Real uploads start with no
    // contact; the user fills it in via the Contact tab. The web-search
    // resolver kicked off below populates `resolved_contact` as a prefill
    // suggestion alongside this.
    contact: defaultContactForFixture(fixtureName),
    contact_status: "pending",
  };
  // Fast path again: when we served a cached audit report for a fixture,
  // also pre-resolve the provider contact synchronously so the plan-
  // review page doesn't show "Looking up…" for 5-10s on a "Try a sample"
  // demo. Real uploads still hit the web-search resolver in background.
  if (existsSync(cachedReportPath) && run.contact) {
    run.contact_status = "resolved";
    run.resolved_contact = {
      email: run.contact.support_email ?? null,
      phone: run.contact.support_phone ?? null,
      source_urls: [],
      confidence: "high",
      notes: "Pre-seeded for the sample fixture.",
      resolved_at: Date.now(),
    };
  }
  savePending(run);

  // Kick off the provider-contact lookup in the background only when we
  // didn't already resolve from the fixture pre-seed. The plan-review
  // tab polls /api/contact/:run_id and shows it as soon as it lands.
  if (run.contact_status !== "resolved") {
    kickoffContactResolution(run.run_id).catch((err) => {
      console.error(`[contact ${run.run_id}]`, err);
    });
  }

  return Response.json({ run_id: run.run_id, report: partial });
}

/**
 * Negotiate something that isn't a bill — flight-delay refunds, defective
 * orders, service complaints, etc. Takes a free-form description, drafts a
 * complaint letter via Opus, and lands the user in the same plan-review
 * flow the bill audit produces. The PendingRun is "complaint-shaped":
 * empty errors[], non-bill metadata, complaint-style appeal letter.
 */
/**
 * One-shot complaint intake. Creates the run with status="negotiating"
 * immediately and returns the run_id so the client can navigate straight
 * to Bills. The slow Opus draft happens in the background; once it lands,
 * we save the appeal letter onto the run and call kickoffNegotiation,
 * which is what actually sends the email.
 */
async function handleComplaint(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    company?: string;
    description?: string;
    desired_outcome?: string;
    support_email?: string | null;
    support_phone?: string | null;
  } | null;
  const company = body?.company?.trim();
  const description = body?.description?.trim();
  if (!company || !description) {
    return Response.json(
      { error: "Missing company or description" },
      { status: 400 },
    );
  }
  const desired = body?.desired_outcome?.trim() ?? "";
  const supportEmail = (typeof body?.support_email === "string" ? body!.support_email.trim() : "") || "";
  const supportPhone = (typeof body?.support_phone === "string" ? body!.support_phone.trim() : "") || "";
  if (!supportEmail && !supportPhone) {
    return Response.json(
      { error: "missing_contact", message: "Add a support email or phone before submitting." },
      { status: 400 },
    );
  }

  // Operator-side gate, same one /api/approve runs. We refuse to create
  // the run at all if real email isn't configured — better than letting
  // a complaint sit in Bills with no way to actually send it.
  const resendKey = process.env.RESEND_API_KEY ?? null;
  const resendFrom = process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL ?? null;
  if (!resendKey || !resendFrom) {
    return Response.json(
      {
        error: "email_not_configured",
        message:
          "Bonsai isn't set up to send real email yet. The operator needs to verify a Resend sending domain and set RESEND_API_KEY + RESEND_FROM.",
      },
      { status: 503 },
    );
  }

  // Build a stub BonsaiReport. The appeal letter is empty for now — the
  // background worker fills it in once Opus is done drafting.
  const fixtureName = `complaint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const partial: BonsaiReport = {
    analyzer: {
      metadata: {
        provider_name: company,
        provider_billing_address: "",
        patient_name: "",
        claim_number: "",
        date_of_service: "",
        insurer_name: "",
        eob_patient_responsibility: 0,
        bill_current_balance_due: 0,
        account_number: "",
        bill_kind: "other",
      },
      errors: [],
      summary: {
        high_confidence_total: 0,
        worth_reviewing_total: 0,
        bill_total_disputed: 0,
        headline: `Complaint to ${company}`,
      },
      grounding_failures: [],
      meta: {
        model: "claude-opus-4-7",
        input_tokens: 0,
        output_tokens: 0,
        elapsed_ms: 0,
        tool_turns: 0,
      },
    },
    appeal: {
      markdown: "",
      subject: `Complaint regarding ${company}`,
      defensible_total: 0,
      used_placeholders: [],
    },
    strategy: {
      chosen: "persistent",
      reason: "Complaint mode: email the company, escalate to phone if they stonewall.",
    },
    summary: {
      original_balance: 0,
      defensible_disputed: 0,
      final_balance: null,
      patient_saved: null,
      channel_used: "persistent",
      outcome: "in_progress",
      outcome_detail: "Drafting the complaint letter.",
    },
  };

  const run: PendingRun = {
    run_id: newRunId(),
    fixture_name: fixtureName,
    bill_path: "",
    bill_paths: [],
    bill_names: [],
    channel: "persistent",
    partial_report: partial,
    qa: [],
    created_at: Date.now(),
    // Skip the audited→negotiating dance: complaint flow has no review
    // step, so we go straight to negotiating once the user submits.
    status: "negotiating",
    approved_at: Date.now(),
    contact: {
      support_email: supportEmail || null,
      support_phone: supportPhone || null,
      support_portal_url: null,
      account_holder_name: null,
      bill_kind: "other",
    },
    contact_status: "resolved",
    resolved_contact: {
      email: supportEmail || null,
      phone: supportPhone || null,
      source_urls: [],
      confidence: "high",
      notes: "User-provided.",
      user_edited: true,
      resolved_at: Date.now(),
    },
  };
  savePending(run);

  // Hand off to the background worker. It drafts via Opus, saves the letter
  // onto the run, then calls kickoffNegotiation which actually sends the
  // email. The user is already on Bills by the time any of this completes.
  void draftComplaintAndKickoff(run.run_id, { company, description, desired }).catch((err) => {
    console.error(`[complaint draft ${run.run_id}]`, err);
    const latest = loadPending(run.run_id);
    if (latest) {
      latest.status = "failed";
      latest.error = (err as Error).message;
      savePending(latest);
    }
  });

  return Response.json({ run_id: run.run_id });
}

/**
 * Background worker for the complaint flow. Drafts the letter via Opus,
 * persists it onto the run, then kicks off the actual outbound negotiation.
 * Run on its own so /api/complaint can return the run_id immediately.
 */
async function draftComplaintAndKickoff(
  runId: string,
  inputs: { company: string; description: string; desired: string },
): Promise<void> {
  const system = [
    "You are Bonsai, drafting a formal complaint letter on the user's behalf to a company.",
    "The user describes the issue and what they want; you produce a tight, persuasive complaint letter that:",
    "  - Opens with a clear ask (refund, replacement, credit, response within 14 days, etc.).",
    "  - States the facts concisely. Reference any specifics the user gave (dates, amounts, order numbers).",
    "  - Cites relevant consumer-protection levers when applicable: DOT 14 CFR Part 250 for flights, FTC Mail/Internet Order rule for online orders, Magnuson-Moss for warranties, state attorney-general / BBB / consumer-affairs as escalation.",
    "  - Closes with a deadline + escalation path.",
    "Tone: firm, professional, never threatening. 200-350 words. No prose outside the tool call.",
    "",
    "Also propose 3-5 strategy opportunities — specific tactics the user could pursue. Each gets a short title + 1-2 sentence description + an upper-bound dollar estimate (or 0 if money isn't the point).",
  ].join("\n");

  const userMsg = [
    `Company: ${inputs.company}`,
    `Issue: ${inputs.description}`,
    inputs.desired ? `Desired outcome: ${inputs.desired}` : "",
  ].filter(Boolean).join("\n");

  const COMPLAINT_TOOL: Anthropic.Tool = {
    name: "draft_complaint",
    description: "Return the drafted complaint letter + tactical opportunities.",
    input_schema: {
      type: "object",
      required: ["subject", "letter_markdown", "headline", "opportunities"],
      properties: {
        subject: { type: "string", description: "Short, professional subject line." },
        letter_markdown: { type: "string", description: "The complaint letter body, markdown OK." },
        headline: { type: "string", description: "1-line summary of what the user is asking for." },
        opportunities: {
          type: "array",
          minItems: 3,
          maxItems: 5,
          items: {
            type: "object",
            required: ["title", "description", "dollar_estimate", "icon"],
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              dollar_estimate: { type: "number", minimum: 0 },
              icon: {
                type: "string",
                enum: ["shield", "scan", "pulse", "doc", "phone", "mail", "sparkle", "check"],
              },
            },
          },
        },
      },
    },
  };

  const anthropic = new Anthropic();
  const resp = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1500,
    system,
    tools: [COMPLAINT_TOOL],
    tool_choice: { type: "tool", name: "draft_complaint" },
    messages: [{ role: "user", content: userMsg }],
  });
  const tool = resp.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "draft_complaint",
  );
  if (!tool) throw new Error("Model did not draft the complaint");
  const drafted = tool.input as {
    subject: string;
    letter_markdown: string;
    headline: string;
    opportunities: Array<{ title: string; description: string; dollar_estimate: number; icon: string }>;
  };

  const run = loadPending(runId);
  if (!run) return; // user must have deleted it
  run.partial_report.appeal.markdown = drafted.letter_markdown;
  run.partial_report.appeal.subject = drafted.subject;
  run.partial_report.analyzer.summary.headline = drafted.headline;
  run.partial_report.summary.outcome_detail = "Negotiation in progress.";
  run.complaint_opportunities = drafted.opportunities;
  savePending(run);

  await kickoffNegotiation(runId);
}

/**
 * Pre-draft chat for the complaint intake screen. The user is filling out
 * the form (company / what happened / desired) and wants to ask Bonsai a
 * question — "is this worth pursuing?", "what's a reasonable ask?", etc.
 *
 * No PendingRun exists yet at this point (the run is created when the user
 * clicks Accept &amp; negotiate), so we keep the conversation client-side
 * and re-send the full history on every turn. Stateless on the server.
 */
async function handleComplaintChat(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    company?: string;
    description?: string;
    desired_outcome?: string;
    history?: Array<{ role: "user" | "assistant"; body: string }>;
    message?: string;
  } | null;
  const message = body?.message?.trim();
  if (!message) {
    return Response.json({ error: "Missing message" }, { status: 400 });
  }
  const company = body?.company?.trim() ?? "";
  const description = body?.description?.trim() ?? "";
  const desired = body?.desired_outcome?.trim() ?? "";
  const history = Array.isArray(body?.history) ? body!.history : [];

  const system = [
    "You are Bonsai, an advisor helping the user fill out a complaint or refund request before we contact the company on their behalf.",
    "The user is mid-form. They may ask whether their case is strong, what to say, what to ask for, or how Bonsai will handle it.",
    "Tone: warm, plain-language, encouraging. 1-3 sentences. No prefaces, no 'great question'.",
    "DO NOT cite regulations, statutes, or legal codes (no 'DOT 14 CFR', 'Magnuson-Moss', 'FTC Mail Order Rule'). Keep it everyday-language. If the user is unsure whether they have a case, give a confidence-building answer in human terms.",
    "Don't draft the full letter — the user hasn't hit Accept yet. Just answer what they asked.",
    "",
    "CURRENT FORM STATE:",
    `Company: ${company || "(blank)"}`,
    `Issue: ${description || "(blank)"}`,
    `Desired outcome: ${desired || "(blank)"}`,
  ].join("\n");

  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const m of history) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.body !== "string" || !m.body.trim()) continue;
    messages.push({ role: m.role, content: m.body });
  }
  messages.push({ role: "user", content: message });

  try {
    const anthropic = new Anthropic();
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 400,
      system,
      messages,
    });
    const reply = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!reply) {
      return Response.json({ error: "Model returned no text" }, { status: 502 });
    }
    return Response.json({ reply });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * Background worker: pull the provider name + billing address off the audit
 * report, ask Claude to look up the billing-dept email/phone via web search,
 * and stash the result on the PendingRun. Idempotent — safe to re-call if
 * the audit page is reloaded mid-flight.
 */
async function kickoffContactResolution(runId: string): Promise<void> {
  const run = loadPending(runId);
  if (!run) return;
  if (run.contact_status === "resolved" && run.resolved_contact?.user_edited) return;
  const meta = run.partial_report?.analyzer?.metadata ?? {};
  const provider_name = (meta.provider_name ?? "").trim();
  if (!provider_name) {
    run.contact_status = "failed";
    run.contact_error = "No provider name found on the bill — cannot search.";
    savePending(run);
    return;
  }
  try {
    const { resolveProviderContact } = await import("./lib/provider-contact.ts");
    const contact = await resolveProviderContact({
      provider_name,
      provider_address: meta.provider_billing_address ?? null,
    });
    const latest = loadPending(runId);
    if (!latest) return;
    if (latest.resolved_contact?.user_edited) return; // user beat us to it
    latest.resolved_contact = {
      email: contact.email,
      phone: contact.phone,
      source_urls: contact.source_urls,
      confidence: contact.confidence,
      notes: contact.notes,
      resolved_at: contact.resolved_at,
    };
    latest.contact_status = "resolved";
    delete latest.contact_error;
    savePending(latest);
  } catch (err) {
    const latest = loadPending(runId);
    if (!latest) return;
    latest.contact_status = "failed";
    latest.contact_error = (err as Error)?.message ?? String(err);
    savePending(latest);
  }
}

async function handleContactStatus(runId: string): Promise<Response> {
  const run = loadPending(runId);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  return Response.json({
    run_id: run.run_id,
    status: run.contact_status ?? "pending",
    contact: run.resolved_contact ?? null,
    error: run.contact_error ?? null,
    provider_name: run.partial_report?.analyzer?.metadata?.provider_name ?? null,
    provider_address: run.partial_report?.analyzer?.metadata?.provider_billing_address ?? null,
  });
}

async function handleContactOverride(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string; email?: string | null; phone?: string | null };
  if (!body.run_id) return Response.json({ error: "Missing run_id" }, { status: 400 });
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  const cleanEmail = typeof body.email === "string" ? body.email.trim() : null;
  const cleanPhone = typeof body.phone === "string" ? body.phone.trim() : null;
  run.resolved_contact = {
    email: cleanEmail || null,
    phone: cleanPhone || null,
    source_urls: run.resolved_contact?.source_urls ?? [],
    confidence: "high", // user-asserted
    notes: "Manually entered by the user.",
    user_edited: true,
    resolved_at: Date.now(),
  };
  // Also mirror into `run.contact` — that's the field hasContactChannel
  // reads at /api/approve. Without this, the user can override a contact
  // here but the launch gate still 412s because it only sees the
  // separately-saved drawer contact. Two contact fields existed for
  // historical reasons (resolved_contact = AI suggestion, contact =
  // user-typed in the drawer); for the plan-review card we keep them
  // in lockstep.
  run.contact = {
    ...(run.contact ?? {}),
    support_email: cleanEmail || null,
    support_phone: cleanPhone || null,
    bill_kind: run.contact?.bill_kind
      ?? (run.partial_report?.analyzer?.metadata?.bill_kind as BillContactT["bill_kind"])
      ?? "medical",
  };
  run.contact_status = "resolved";
  delete run.contact_error;
  savePending(run);
  return Response.json({ ok: true, contact: run.resolved_contact });
}

async function handleContactRetry(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string };
  if (!body.run_id) return Response.json({ error: "Missing run_id" }, { status: 400 });
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  run.contact_status = "pending";
  delete run.contact_error;
  // Drop the user_edited flag so a retry can overwrite.
  if (run.resolved_contact) {
    run.resolved_contact.user_edited = false;
  }
  savePending(run);
  kickoffContactResolution(run.run_id).catch((err) => {
    console.error(`[contact retry ${run.run_id}]`, err);
  });
  return Response.json({ ok: true, status: run.contact_status });
}

async function handleAsk(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string; question?: string };
  if (!body.run_id || !body.question?.trim()) {
    return Response.json({ error: "Missing run_id or question" }, { status: 400 });
  }
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });

  const r = run.partial_report;
  const findingsText = r.analyzer.errors
    .map(
      (e, i) =>
        `${i + 1}. [${e.confidence.toUpperCase()} / ${e.error_type}] ${e.line_quote} — ${e.evidence ?? ""} (impact ~ $${e.dollar_impact?.toFixed?.(2) ?? "?"})`,
    )
    .join("\n");
  const metaText = [
    `Provider: ${r.analyzer.metadata.provider_name ?? "—"}`,
    `Patient: ${r.analyzer.metadata.patient_name ?? "—"}`,
    `Date of service: ${r.analyzer.metadata.date_of_service ?? "—"}`,
    `Current balance due: $${(r.analyzer.metadata.bill_current_balance_due ?? 0).toFixed(2)}`,
    `Defensible disputable: $${r.summary.defensible_disputed.toFixed(2)}`,
    `Chosen channel: ${r.strategy.chosen} — ${r.strategy.reason}`,
  ].join("\n");

  const system = [
    "You are Bonsai, a bill audit assistant. The user just received the findings on their bill",
    "and is asking a follow-up question before approving the negotiation plan. Answer in 2-5 sentences,",
    "grounded in the audit data below. Be direct and specific. If the answer is not in the audit,",
    "say so and suggest what the user could do next. Never invent dollar amounts, dates, or codes.",
  ].join(" ");
  const userMsg = [
    "AUDIT METADATA:",
    metaText,
    "",
    "FINDINGS:",
    findingsText || "(no findings)",
    "",
    "APPEAL LETTER SUBJECT: " + r.appeal.subject,
    "",
    "QUESTION:",
    body.question.trim(),
  ].join("\n");

  try {
    const anthropic = new Anthropic();
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const ts = new Date().toISOString();
    run.qa.push({ q: body.question.trim(), a: text, ts });
    savePending(run);
    return Response.json({ answer: text, ts });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * Chat-style plan editor. The user talks to the agent about the negotiation
 * plan; Opus replies AND returns a structured update to strategy.chosen,
 * strategy.reason, and plan_edits (natural-language directives that the
 * negotiation agents will honor on approve). Chat history is persisted on
 * the PendingRun so the conversation has continuity across turns.
 */
async function handlePlanChat(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string; message?: string };
  if (!body.run_id || !body.message?.trim()) {
    return Response.json({ error: "Missing run_id or message" }, { status: 400 });
  }
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });

  const r = run.partial_report;
  const findingsText = r.analyzer.errors
    .map(
      (e, i) =>
        `${i + 1}. [${e.confidence.toUpperCase()} / ${e.error_type}] ${e.line_quote} — ${e.evidence ?? ""} ($${e.dollar_impact?.toFixed?.(2) ?? "?"})`,
    )
    .join("\n");
  const defensible = r.summary.defensible_disputed ?? 0;
  const floorEstimate = Math.max(0, (r.summary.original_balance ?? 0) - defensible);

  const history = run.plan_chat ?? [];
  const system = [
    "You are Bonsai, helping the user before we contact the provider. Two kinds of messages come in:",
    "  1. Questions about the bill / findings — answer them directly using the audit data below.",
    "  2. Plan changes — update strategy_chosen and append a directive for the negotiation agents.",
    "Decide which the message is, then reply.",
    "Tone: terse, direct. 1-3 sentences. Don't dump the whole plan, just respond to what they asked.",
    "",
    "Reply via the update_plan tool call (no prose outside the tool). The tool has four fields:",
    "- chat_reply: 1-3 sentences that either answer the question OR acknowledge the plan change.",
    "- strategy_chosen: one of email / voice / persistent. Pick the channel that matches the user's intent. Default to the existing channel if the user didn't explicitly change it.",
    "- strategy_reason: one short sentence explaining the chosen channel in light of all user input so far.",
    "- plan_edits_append: the NEW directive in this turn only (prior directives are already on file). Empty string if this turn is just Q&A.",
    "",
    "FINDINGS:",
    findingsText || "(no findings)",
    `Defensible total: $${defensible.toFixed(2)}. Rough floor: $${floorEstimate.toFixed(2)}.`,
    `Current channel: ${r.strategy.chosen}. Current reason: ${r.strategy.reason}`,
  ].join("\n");

  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const m of history) {
    messages.push({ role: m.role === "user" ? "user" : "assistant", content: m.body });
  }
  messages.push({ role: "user", content: body.message.trim() });

  const UPDATE_PLAN_TOOL: Anthropic.Tool = {
    name: "update_plan",
    description: "Acknowledge the user's plan-edit message and return the updated strategy.",
    input_schema: {
      type: "object",
      required: ["chat_reply", "strategy_chosen", "strategy_reason", "plan_edits_append"],
      properties: {
        chat_reply: { type: "string", description: "1-2 sentence reply shown in the chat log." },
        strategy_chosen: { type: "string", enum: ["email", "voice", "persistent"] },
        strategy_reason: { type: "string", description: "One short sentence explaining the chosen channel." },
        plan_edits_append: { type: "string", description: "New natural-language directive to append, or empty string." },
      },
    },
  };

  try {
    const anthropic = new Anthropic();
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 400,
      system,
      tools: [UPDATE_PLAN_TOOL],
      tool_choice: { type: "tool", name: "update_plan" },
      messages,
    });
    const toolBlock = resp.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "update_plan",
    );
    if (!toolBlock) {
      return Response.json({ error: "Model did not return update_plan" }, { status: 502 });
    }
    const input = toolBlock.input as {
      chat_reply: string;
      strategy_chosen: "email" | "voice" | "persistent";
      strategy_reason: string;
      plan_edits_append: string;
    };

    const ts = new Date().toISOString();
    run.plan_chat = [
      ...(run.plan_chat ?? []),
      { role: "user", body: body.message.trim(), ts },
      { role: "assistant", body: input.chat_reply, ts },
    ];
    // Channel + reason update live on the partial report so the UI re-renders.
    run.partial_report.strategy.chosen = input.strategy_chosen;
    run.partial_report.strategy.reason = input.strategy_reason;
    // Append the new directive so negotiation agents get the full context.
    const append = input.plan_edits_append?.trim();
    if (append) {
      run.plan_edits = run.plan_edits ? `${run.plan_edits}\n- ${append}` : `- ${append}`;
    }
    savePending(run);
    return Response.json({
      reply: input.chat_reply,
      strategy: run.partial_report.strategy,
      plan_edits: run.plan_edits ?? "",
      ts,
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * Produce a small JPEG preview for a just-dropped file. Browsers can't
 * render HEIC/HEIF natively, so the upload staging UI hits this endpoint
 * for every tile and swaps the fallback label for a real thumbnail.
 */
async function handleThumbnail(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return Response.json({ error: "Missing file" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const thumb = await thumbnailBillBytes(bytes, file.name, 360);
    if (!thumb) {
      return Response.json({ error: "Unsupported for preview" }, { status: 415 });
    }
    return new Response(new Uint8Array(thumb), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * Bill-specific negotiation strategies. Runs Opus on the audit report and
 * asks it to propose 3-6 strategies that actually apply to THIS bill —
 * no generic "get a competitor quote" on a dental bill, no "charity care"
 * on a subscription. Each strategy has a grounded dollar estimate.
 */
async function handleOpportunities(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string };
  if (!body.run_id) return Response.json({ error: "Missing run_id" }, { status: 400 });
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });

  // Complaint flow: opportunities were drafted at intake time and stashed
  // on the run. Just return them — no second Opus call.
  if (run.complaint_opportunities && !run.plan_edits?.trim()) {
    return Response.json({ opportunities: run.complaint_opportunities });
  }
  // Fast path: ship a hand-curated opportunities list for any fixture
  // that has fixtures/<name>.opportunities.json next to its PDF. Skips a
  // ~10s Opus call on the demo path. Bypassed when the user has chatted
  // with the plan (run.plan_edits set) — we want their directive to
  // actually steer the opportunities list, not get ignored. Real uploads
  // always hit the live model below.
  const cachedOppsPath = join(FIXTURES_DIR, `${run.fixture_name}.opportunities.json`);
  if (existsSync(cachedOppsPath) && !run.plan_edits?.trim()) {
    const cached = JSON.parse(readFileSync(cachedOppsPath, "utf-8")) as {
      opportunities: Array<{ title: string; description: string; dollar_estimate: number; icon: string }>;
    };
    return Response.json({ opportunities: cached.opportunities });
  }

  const r = run.partial_report;
  const meta = r.analyzer?.metadata ?? {};
  const summary = r.summary ?? {};
  const errors = r.analyzer?.errors ?? [];
  const high = errors.filter((e) => e.confidence === "high");
  const worth = errors.filter((e) => e.confidence === "worth_reviewing");

  const findingsText = errors.length === 0
    ? "No billing errors flagged."
    : errors.map((e, i) => `${i + 1}. [${e.confidence}/${e.error_type}] $${e.dollar_impact} — ${e.line_quote.slice(0, 120)}`).join("\n");

  const system = [
    "You are Bonsai, an agent that negotiates bills of all kinds (medical, dental, pet, utility, subscription, contractor, legal, etc.).",
    "Given an audited bill, propose 3-6 SPECIFIC strategies to lower it. Every strategy must make sense for THIS bill's category and context — no generic 'competitor quote' on a one-off dental bill, no 'charity care' on a subscription, no 'cancel threat' on a one-time procedure.",
    "",
    "Rules:",
    "- Each strategy must be category-appropriate. Medical/dental → charity care, financial hardship, out-of-network negotiation, No-Surprises-Act. Pet → payment plan, pet-insurance reimbursement, vendor price-match if applicable. Utility/telecom → retention offer, rate-class recheck, autopay discount, competitor switch threat. Subscription/software → cancel-threat retention, annual prepay, loyalty tier. Contractor/legal → change-order audit, warranty, state licensing-board or bar complaint leverage. One-time service bills never use 'cancel threat' or 'switch competitor'.",
    "- Dollar estimates should be grounded: billing-error disputes = defensible amount. Negotiation of remaining balance = realistic percentage (typically 5-25%). Loophole/discount = specific policy-based amount if inferrable, else a modest %.",
    "- Titles are 2-6 words, imperative voice ('Dispute billing errors', 'Apply for charity care', 'Demand retention credit').",
    "- Descriptions are 1-2 sentences, concrete, reference the actual bill (provider name, line items) when it sharpens the point.",
    "- Do not include prose commentary outside the tool call.",
  ].join("\n");

  const userMsg = [
    `Bill provider: ${meta.provider_name ?? "—"}`,
    `Date of service: ${meta.date_of_service ?? "—"}`,
    `Original balance: $${summary.original_balance?.toFixed?.(2) ?? "?"}`,
    `Defensible disputable (from billing errors): $${(summary.defensible_disputed ?? 0).toFixed(2)}`,
    `High-confidence findings: ${high.length}. Worth-reviewing: ${worth.length}.`,
    "",
    "Findings:",
    findingsText,
    run.plan_edits ? `\nUser directives: ${run.plan_edits}` : "",
  ].filter(Boolean).join("\n");

  const OPPS_TOOL: Anthropic.Tool = {
    name: "propose_opportunities",
    description: "Return 3-6 bill-specific strategies to lower this bill.",
    input_schema: {
      type: "object",
      required: ["opportunities"],
      properties: {
        opportunities: {
          type: "array",
          minItems: 3,
          maxItems: 6,
          items: {
            type: "object",
            required: ["title", "description", "dollar_estimate", "icon"],
            properties: {
              title: { type: "string", description: "2-6 words, imperative." },
              description: { type: "string", description: "1-2 sentences, concrete, references the bill when helpful." },
              dollar_estimate: { type: "number", minimum: 0, description: "Realistic savings in dollars. 0 if truly unknown." },
              icon: {
                type: "string",
                enum: ["shield", "scan", "pulse", "doc", "phone", "mail", "pill", "hospital", "sparkle", "check"],
                description: "Pick the icon that best matches the strategy's vibe.",
              },
            },
          },
        },
      },
    },
  };

  try {
    const anthropic = new Anthropic();
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 1200,
      system,
      tools: [OPPS_TOOL],
      tool_choice: { type: "tool", name: "propose_opportunities" },
      messages: [{ role: "user", content: userMsg }],
    });
    const tool = resp.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "propose_opportunities",
    );
    if (!tool) return Response.json({ error: "Model did not return opportunities" }, { status: 502 });
    const { opportunities } = tool.input as {
      opportunities: Array<{ title: string; description: string; dollar_estimate: number; icon: string }>;
    };
    return Response.json({ opportunities });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

async function handleApprove(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string; plan_edits?: string };
  if (!body.run_id) return Response.json({ error: "Missing run_id" }, { status: 400 });
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });

  if (!hasContactChannel(run.contact)) {
    return Response.json(
      { error: "missing_contact", message: "Add a support email or phone in the Contact tab before launching the agent." },
      { status: 412 },
    );
  }

  // Operator-side gate: refuse to launch unless Resend is configured at
  // the platform level. Email delivery is operator-owned (single verified
  // sending domain for all users), so this fails-closed when the operator
  // hasn't set the env vars yet — better than silently running the
  // simulator and writing a fake "resolved" outcome.
  const resendKey = process.env.RESEND_API_KEY ?? null;
  const resendFrom = process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL ?? null;
  if (!resendKey || !resendFrom) {
    return Response.json(
      {
        error: "email_not_configured",
        message:
          "Bonsai isn't set up to send real email yet. The operator needs to verify a Resend sending domain and set RESEND_API_KEY + RESEND_FROM.",
      },
      { status: 503 },
    );
  }

  if (body.plan_edits) {
    run.plan_edits = body.plan_edits;
    run.partial_report.strategy.reason =
      `${run.partial_report.strategy.reason}\n\nUser edits: ${body.plan_edits}`;
  }

  // Negotiation is slow — minutes of simulated back-and-forth — so we run it
  // in the background and return immediately. The user hops to the Bills
  // view, which polls /api/history to pick up the status change.
  run.status = "negotiating";
  run.approved_at = Date.now();
  savePending(run);

  kickoffNegotiation(run.run_id).catch((err) => {
    console.error(`[bg negotiation ${run.run_id}]`, err);
  });

  return Response.json({
    run_id: run.run_id,
    status: run.status,
    fixture_name: run.fixture_name,
    provider_name: run.partial_report.analyzer?.metadata?.provider_name ?? null,
    channel: run.partial_report.strategy.chosen,
  });
}

/**
 * Background negotiation worker. Runs the full phase against the persisted
 * PendingRun and updates status + on-disk report when done. If the user
 * hit Stop (status → "cancelled") while we were working, we don't overwrite
 * the cancellation with "completed".
 */
async function kickoffNegotiation(runId: string): Promise<void> {
  const run = loadPending(runId);
  if (!run) return;
  const { getProfileConfig, getTuneConfig } = await import("./lib/user-settings.ts");
  const profile = getProfileConfig();
  const tune = getTuneConfig();
  const originalBalance = run.partial_report?.summary?.original_balance ?? 0;
  const floorFromTune =
    originalBalance > 0 ? originalBalance * (1 - tune.floor_pct / 100) : undefined;
  try {
    // CC the user on every outbound so the rep sees a real account holder
    // on the line (legitimacy + deliverability) and can Reply-All to keep
    // them in sync. Backstop forward in the inbound webhook covers reps
    // who hit just Reply.
    const cc = profile.email ? [profile.email] : undefined;
    const full = await runNegotiationPhase(run.partial_report, {
      billPdfPath: run.bill_path,
      eobPdfPath: run.eob_path,
      billFixtureName: run.fixture_name,
      channel: run.channel,
      email_persona: run.email_persona,
      voice_persona: run.voice_persona,
      user_email: profile.email ?? undefined,
      user_phone: profile.phone ?? undefined,
      // Provider contact precedence: user-typed contact (Contact tab) wins
      // over the AI-resolved one, which wins over the orchestrator's
      // placeholder. The user-set value is the only one we trust to be
      // correct for non-synthetic providers — the AI lookup may have
      // failed (web search hit no real source) or be stale.
      provider_email:
        run.contact?.support_email ?? run.resolved_contact?.email ?? undefined,
      provider_phone:
        run.contact?.support_phone ?? run.resolved_contact?.phone ?? undefined,
      final_acceptable_floor: run.final_acceptable_floor ?? floorFromTune,
      channels_enabled: run.channels_enabled ?? tune.channels,
      agent_tone: run.agent_tone ?? tune.tone,
      user_directives: run.user_directives,
      cc,
    });
    const latest = loadPending(runId);
    if (latest?.status === "cancelled") {
      // User pulled the plug mid-flight. Don't clobber the cancelled state
      // or write the completed report to disk.
      return;
    }
    const paths = currentUserPaths();
    mkdirSync(paths.reportsDir, { recursive: true });
    writeFileSync(paths.reportPath(run.fixture_name), JSON.stringify(full, null, 2));
    writeFileSync(paths.appealPath(run.fixture_name), full.appeal.markdown);
    if (latest) {
      latest.partial_report = full;
      latest.status = "completed";
      latest.completed_at = Date.now();
      savePending(latest);
    }
  } catch (err) {
    const latest = loadPending(runId);
    if (latest && latest.status !== "cancelled") {
      latest.status = "failed";
      latest.error = (err as Error)?.message ?? String(err);
      savePending(latest);
    }
    throw err;
  }
}

async function handleStopNegotiation(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string };
  if (!body.run_id) return Response.json({ error: "Missing run_id" }, { status: 400 });
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });
  // We can't actually interrupt in-flight Anthropic calls — the worker will
  // finish its current turn. What we CAN do is flip state so the UI reflects
  // the stop immediately AND the worker's "write completed" branch bails.
  run.status = "cancelled";
  run.error = "Stopped by user";
  run.completed_at = Date.now();
  savePending(run);
  return Response.json({ run_id: run.run_id, status: run.status });
}

/**
 * Delete a bill entirely. Removes the PendingRun plus any on-disk report
 * and appeal letter tied to the same fixture_name. Only the files
 * registered to this run are touched — other bills are untouched.
 */
async function handleDeleteBill(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string };
  if (!body.run_id) return Response.json({ error: "Missing run_id" }, { status: 400 });
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });

  // Flip status so any in-flight worker bails out before writing anything.
  run.status = "cancelled";
  run.error = "Deleted by user";
  savePending(run);

  const tryUnlink = (p: string): void => {
    if (existsSync(p)) {
      try { unlinkSync(p); } catch (err) { console.warn("[delete] unlink failed", p, err); }
    }
  };

  tryUnlink(pendingPath(run.run_id));
  const userP = currentUserPaths();
  tryUnlink(userP.reportPath(run.fixture_name));
  tryUnlink(userP.appealPath(run.fixture_name));
  // Uploaded bill files are per-user content — clean those up too so the
  // uploads dir doesn't grow without bound. Scoped strictly to this run's
  // recorded paths; nothing else gets touched.
  for (const p of run.bill_paths ?? []) {
    if (p.startsWith(uploadDir())) tryUnlink(p);
  }
  if (run.eob_path && run.eob_path.startsWith(uploadDir())) tryUnlink(run.eob_path);

  return Response.json({ ok: true, run_id: run.run_id });
}

async function handleResumeNegotiation(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string };
  if (!body.run_id) return Response.json({ error: "Missing run_id" }, { status: 400 });
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });
  if (run.status === "negotiating") {
    return Response.json({ error: "Already negotiating" }, { status: 400 });
  }
  if (!hasContactChannel(run.contact)) {
    return Response.json(
      { error: "missing_contact", message: "Add a support email or phone in the Contact tab before resuming the agent." },
      { status: 412 },
    );
  }
  // Start covers three cases:
  //   - audited (never approved)      → kick off the first negotiation round
  //   - cancelled / failed (paused)   → resume where we left off
  //   - completed (recurring check)   → start a fresh round against the same bill
  // Fold user feedback into plan_edits AND parse it for structured directives
  // (channel gates, tone). The agent respects both on the next round.
  const userFeedback = (run.feedback ?? [])
    .filter((f) => f.role === "user")
    .map((f) => f.body);
  if (userFeedback.length > 0) {
    const { parseFeedbackDirectives } = await import("./lib/feedback-parser.ts");
    const { getTuneConfig } = await import("./lib/user-settings.ts");
    const tune = getTuneConfig();
    const parsed = parseFeedbackDirectives(userFeedback);
    run.channels_enabled = {
      email: parsed.channels?.email ?? tune.channels.email,
      voice: parsed.channels?.voice ?? tune.channels.voice,
    };
    run.agent_tone = parsed.tone ?? tune.tone;
    run.user_directives = parsed.notes.join("\n");
    const extra = `Resumed with user feedback:\n${parsed.notes.map((n) => `- ${n}`).join("\n")}`;
    run.plan_edits = run.plan_edits ? `${run.plan_edits}\n\n${extra}` : extra;
  }
  run.status = "negotiating";
  run.error = undefined;
  run.approved_at = Date.now();
  savePending(run);

  kickoffNegotiation(run.run_id).catch((err) => {
    console.error(`[bg resume ${run.run_id}]`, err);
  });

  return Response.json({ run_id: run.run_id, status: run.status });
}

async function handleGetFeedback(runId: string): Promise<Response> {
  const run = loadPending(runId);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });
  return Response.json({
    run_id: run.run_id,
    status: run.status ?? "audited",
    feedback: run.feedback ?? [],
  });
}

async function handleVerifyOutcome(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { run_id?: string; verified?: "yes" | "no" | "partial"; notes?: string }
    | null;
  if (!body?.run_id || !body?.verified) {
    return Response.json({ error: "Missing run_id or verified" }, { status: 400 });
  }
  if (!["yes", "no", "partial"].includes(body.verified)) {
    return Response.json({ error: "Invalid verified value" }, { status: 400 });
  }
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  run.outcome_verified = body.verified;
  run.outcome_verified_at = Date.now();
  if (body.notes?.trim()) run.outcome_notes = body.notes.trim();
  savePending(run);
  return Response.json({
    ok: true,
    run_id: run.run_id,
    outcome_verified: run.outcome_verified,
    outcome_verified_at: run.outcome_verified_at,
    outcome_notes: run.outcome_notes ?? null,
  });
}

async function handleFeedback(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string; message?: string };
  if (!body.run_id || !body.message?.trim()) {
    return Response.json({ error: "Missing run_id or message" }, { status: 400 });
  }
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });

  // Short acknowledging reply via Opus, grounded in the active bill state.
  const meta = run.partial_report?.analyzer?.metadata ?? {};
  const prior = run.feedback ?? [];
  const system = [
    "You are Bonsai. The user has stopped the agent on their bill and is now giving feedback about how you should negotiate differently going forward.",
    "Acknowledge the feedback in 1-2 sentences. Be specific — reference what they just told you. If what they're asking conflicts with the current plan, say so briefly. If it's clear, say you've got it and will apply it on resume. Never say 'I'll try', just say you'll do it.",
    "",
    `Provider: ${meta.provider_name ?? "—"}. Current status: ${run.status}.`,
    `Existing user feedback on file: ${prior.filter((p) => p.role === "user").map((p) => p.body).join(" | ") || "(none)"}`,
  ].join("\n");

  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const f of prior) {
    messages.push({ role: f.role === "user" ? "user" : "assistant", content: f.body });
  }
  messages.push({ role: "user", content: body.message.trim() });

  let reply = "Got it. I'll apply that when you resume.";
  try {
    const anthropic = new Anthropic();
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 200,
      system,
      messages,
    });
    const text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (text) reply = text;
  } catch (err) {
    console.error("[feedback] opus failed", err);
  }

  const ts = new Date().toISOString();
  run.feedback = [
    ...prior,
    { role: "user", body: body.message.trim(), ts },
    { role: "assistant", body: reply, ts },
  ];
  savePending(run);
  return Response.json({ reply, feedback: run.feedback, ts });
}

/**
 * Sanitize a free-form phone number into something callable. Strips
 * whitespace, parens, dashes, and dots; preserves the leading + when
 * present. Doesn't validate country codes — bad numbers fail at dial time.
 */
/**
 * Return demo-ready contact info for shipped fixtures so the gate doesn't
 * block 'Try a sample.' Returns undefined for unknown bill names — real
 * uploads must fill in contact info via the Contact tab.
 */
function defaultContactForFixture(fixtureName: string): BillContactT | undefined {
  const fixtures: Record<string, BillContactT> = {
    "bill-001": {
      support_email: "billing@stsynthetic.example",
      support_phone: "+15555550101",
      support_portal_url: null,
      account_holder_name: null,
      bill_kind: "medical",
    },
    "bill-002": {
      support_email: "patientaccounts@orthosynthetic.example",
      support_phone: "+15555550102",
      support_portal_url: null,
      account_holder_name: null,
      bill_kind: "medical",
    },
  };
  return fixtures[fixtureName];
}

function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[\s().\-]+/g, "");
  if (!/^\+?[0-9]{7,15}$/.test(cleaned)) return null;
  return cleaned;
}

async function handleGetContact(runId: string): Promise<Response> {
  const run = loadPending(runId);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });
  return Response.json({
    run_id: run.run_id,
    contact: run.contact ?? null,
    can_launch: hasContactChannel(run.contact ?? null),
  });
}

async function handleSetContact(req: Request, runId: string): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = BillContact.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid contact info", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const c = parsed.data;
  const normalizedPhone = normalizePhone(c.support_phone ?? null);
  if (c.support_phone && !normalizedPhone) {
    return Response.json(
      { error: "support_phone is not a parseable phone number" },
      { status: 400 },
    );
  }

  const run = loadPending(runId);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });

  run.contact = {
    support_email: c.support_email ?? null,
    support_phone: normalizedPhone,
    support_portal_url: c.support_portal_url ?? null,
    account_holder_name: c.account_holder_name ?? null,
    bill_kind: c.bill_kind,
  };
  savePending(run);

  return Response.json({
    run_id: run.run_id,
    contact: run.contact,
    can_launch: hasContactChannel(run.contact),
  });
}

async function handleUpload(req: Request): Promise<Response> {
  const form = await req.formData();
  const billFile = form.get("bill") as File | null;
  const eobFile = form.get("eob") as File | null; // optional — supporting doc
  // Default to persistent: the user dropped a bill, they want it pushed to the floor.
  const channel = (form.get("channel") as Channel) ?? "persistent";
  if (!billFile) {
    return Response.json({ error: "Missing bill file" }, { status: 400 });
  }
  mkdirSync(uploadDir(), { recursive: true });
  const uploadId = `upload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const billPath = join(uploadDir(), `${uploadId}-bill.pdf`);
  writeFileSync(billPath, new Uint8Array(await billFile.arrayBuffer()));

  // Ground truth resolution:
  //   - If a shipped fixture markdown exists for this filename, use it (the
  //     fixture demo path — exact, deterministic).
  //   - Otherwise extract text directly from the uploaded PDF via `unpdf`.
  //     Scanned / image-only PDFs throw `ScannedPdfError` and we surface a
  //     clear message rather than silently OCR'ing (which would weaken the
  //     verbatim line_quote contract).
  const baseName = billFile.name.replace(/\.pdf$/i, "");
  const groundTruthPath = join(FIXTURES_DIR, `${baseName}.md`);
  let analyzeInput: AnalyzeInput | undefined;
  if (!existsSync(groundTruthPath)) {
    let extracted;
    try {
      extracted = await extractPdfText(billPath);
    } catch (err) {
      if (err instanceof ScannedPdfError) {
        return Response.json(
          { error: err.message, code: err.code },
          { status: 400 },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: `Could not read the uploaded PDF: ${msg}` },
        { status: 400 },
      );
    }
    const billNormalized = await normalizeBillFile(billPath, billFile.name);
    analyzeInput = {
      bill: billNormalized,
      billGroundTruth: groundTruthFromText(extracted.full, billPath),
    };
  }

  // Resolve an EOB source: prefer the uploaded file, then the shipped fixture
  // that matches this bill name. Medical audits need the EOB for cross-reference;
  // if neither exists, surface a clear error.
  let eobPath: string | null = null;
  if (eobFile) {
    eobPath = join(uploadDir(), `${uploadId}-eob.pdf`);
    writeFileSync(eobPath, new Uint8Array(await eobFile.arrayBuffer()));
  } else {
    const fixtureEobName = baseName.replace(/^bill-/, "eob-");
    const fixtureEobPath = join(FIXTURES_DIR, `${fixtureEobName}.pdf`);
    if (existsSync(fixtureEobPath)) eobPath = fixtureEobPath;
  }
  if (!eobPath) {
    return Response.json(
      { error: `No supporting doc found. Expected fixtures/${baseName.replace(/^bill-/, "eob-")}.pdf` },
      { status: 400 },
    );
  }

  if (analyzeInput) {
    analyzeInput.eob = await normalizeBillFile(eobPath, basename(eobPath));
  }

  const report = await runBonsai({
    billPdfPath: billPath,
    eobPdfPath: eobPath,
    billFixtureName: baseName,
    analyzeInput,
    channel,
  });
  return Response.json(report);
}

/**
 * Serve an uploaded bill file back to the UI so the user can view what they
 * dropped. Scoped to a live run_id — there is no directory listing and no
 * arbitrary path access: the file must be registered in the PendingRun.
 */
async function handleViewBill(runId: string, indexStr: string): Promise<Response> {
  const run = loadPending(runId);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isInteger(index) || index < 0 || index >= run.bill_paths.length) {
    return Response.json({ error: "Bad bill index" }, { status: 400 });
  }
  const path = run.bill_paths[index];
  // Defense in depth: the path must live under the uploads dir or the
  // fixtures dir (fixture runs keep a reference to fixtures/<name>.pdf).
  if (!path.startsWith(uploadDir()) && !path.startsWith(FIXTURES_DIR)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!existsSync(path)) return Response.json({ error: "File missing on disk" }, { status: 404 });
  const ext = (extensionOf(path) ?? "bin").toLowerCase();
  const name = run.bill_names[index] ?? basename(path);
  const bytes = readFileSync(path);

  // Browsers can't render HEIC/HEIF/TIFF inline. Transcode to a preview
  // JPEG so clicking "View file" always shows the image, not a download.
  if (ext === "heic" || ext === "heif" || ext === "tif" || ext === "tiff") {
    try {
      const jpeg = await thumbnailBillBytes(bytes, name, 1600);
      if (jpeg) {
        return new Response(new Uint8Array(jpeg), {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Disposition": `inline; filename="${name.replace(/"/g, "").replace(/\.[^.]+$/, "")}.jpg"`,
            "Cache-Control": "private, max-age=3600",
          },
        });
      }
    } catch (err) {
      console.error("[view-bill] transcode failed", err);
      // fall through to raw bytes
    }
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": billMediaMime(ext),
      "Content-Disposition": `inline; filename="${name.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** List the files registered to a run so the UI can render a viewer. */
async function handleListBill(runId: string): Promise<Response> {
  const run = loadPending(runId);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });
  const files = run.bill_paths.map((p, i) => ({
    index: i,
    name: run.bill_names[i] ?? basename(p),
    ext: extensionOf(p) ?? "bin",
    mime: billMediaMime(extensionOf(p) ?? "bin"),
    url: `/api/bill/${runId}/${i}`,
  }));
  const eob = run.eob_path
    ? {
        name: run.eob_name ?? basename(run.eob_path),
        ext: extensionOf(run.eob_path) ?? "bin",
        mime: billMediaMime(extensionOf(run.eob_path) ?? "bin"),
      }
    : null;
  return Response.json({ files, eob });
}

async function handleStatic(pathname: string): Promise<Response> {
  // Path split: `/` is the marketing landing page, `/app` and any
  // deep-linked `/app/...` boot the SPA shell. Asset URLs stay rooted at
  // `/assets/...` regardless.
  let path: string;
  if (pathname === "/") {
    path = "/landing.html";
  } else if (pathname === "/app" || pathname.startsWith("/app/")) {
    path = "/index.html";
  } else {
    path = pathname;
  }
  // Allow extensionless URLs like `/terms` to resolve to `terms.html` so we
  // don't have to special-case static legal pages in the route table.
  let fsPath = join(PUBLIC_DIR, path);
  if (!existsSync(fsPath) && !path.includes(".")) {
    const htmlPath = `${path}.html`;
    const htmlFs = join(PUBLIC_DIR, htmlPath);
    if (existsSync(htmlFs)) {
      path = htmlPath;
      fsPath = htmlFs;
    }
  }
  if (!existsSync(fsPath)) return new Response("Not found", { status: 404 });
  // naive path traversal guard: must start with PUBLIC_DIR
  const resolved = fsPath;
  if (!resolved.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
  return new Response(readFileSync(resolved), {
    headers: {
      "Content-Type": contentType(path),
      // Force re-validation on every load so iterating on app.js/app.css
      // doesn't strand the user on a stale build. Cheap during dev; can
      // tighten in production once we have hashed asset URLs.
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
}

async function handleListFixtures(): Promise<Response> {
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.startsWith("bill-") && f.endsWith(".pdf"))
    .map((f) => basename(f, ".pdf"))
    .sort();
  return Response.json({ fixtures: files });
}

async function handleHistory(): Promise<Response> {
  const { readdirSync, statSync } = await import("node:fs");
  const outDir = currentUserPaths().reportsDir;
  if (!existsSync(outDir)) return Response.json({ audits: [], letters: [] });
  const entries = readdirSync(outDir);

  // Index every PendingRun on disk by fixture_name so each audit row can
  // carry its run_id — that's what the drawer needs for Delete / Stop /
  // Start. Completed runs still have a pending file (we update status to
  // 'completed' but keep the record).
  const pendingByName = new Map<string, PendingRun>();
  if (existsSync(pendingDir())) {
    for (const file of readdirSync(pendingDir())) {
      if (!file.endsWith(".json")) continue;
      try {
        const run = JSON.parse(readFileSync(join(pendingDir(), file), "utf-8")) as PendingRun;
        pendingByName.set(run.fixture_name, run);
      } catch { /* skip malformed */ }
    }
  }

  const completed = entries
    .filter((f) => f.startsWith("report-") && f.endsWith(".json"))
    .map((f) => {
      const name = f.slice("report-".length, -".json".length);
      const full = join(outDir, f);
      let report: any = null;
      try { report = JSON.parse(readFileSync(full, "utf-8")); } catch { /* ignore */ }
      const stat = statSync(full);
      const summary = report?.summary ?? {};
      const meta = report?.analyzer?.metadata ?? {};
      const pending = pendingByName.get(name);
      // "Verify outcome" flag: resolved bills older than the threshold that
      // the user hasn't confirmed match their next statement. The frontend
      // funnels these into the Needs-attention bucket so they don't get
      // forgotten — measuring outcomes is what makes the agent trustworthy.
      const resolvedAt = pending?.completed_at ?? stat.mtimeMs;
      const ageDays = (Date.now() - resolvedAt) / (1000 * 60 * 60 * 24);
      const needsOutcomeCheck =
        summary.outcome === "resolved" &&
        !pending?.outcome_verified &&
        ageDays >= VERIFY_OUTCOME_AFTER_DAYS;
      return {
        name,
        modified: stat.mtimeMs,
        provider_name: meta.provider_name ?? null,
        patient_name: meta.patient_name ?? null,
        date_of_service: meta.date_of_service ?? null,
        original_balance: summary.original_balance ?? null,
        final_balance: summary.final_balance ?? null,
        patient_saved: summary.patient_saved ?? null,
        channel_used: summary.channel_used ?? null,
        outcome: summary.outcome ?? null,
        defensible_disputed: summary.defensible_disputed ?? null,
        findings_count: report?.analyzer?.errors?.length ?? 0,
        has_letter: existsSync(join(outDir, `appeal-${name}.md`)),
        status: (pending?.status ?? "completed") as "completed" | "negotiating" | "failed" | "cancelled" | "audited",
        run_id: pending?.run_id ?? null,
        contact: pending?.contact ?? null,
        can_launch: hasContactChannel(pending?.contact ?? null),
        bill_kind: (pending?.contact?.bill_kind ?? meta.bill_kind ?? "medical") as string,
        outcome_verified: pending?.outcome_verified ?? null,
        outcome_notes: pending?.outcome_notes ?? null,
        outcome_verified_at: pending?.outcome_verified_at ?? null,
        needs_outcome_check: needsOutcomeCheck,
      };
    });

  // Surface any PendingRun whose fixture_name didn't match a completed
  // report — these are in-flight, audited-but-not-approved, cancelled,
  // or failed runs. run_id is preserved so the drawer can act on them.
  const inflight: typeof completed = [];
  const seenNames = new Set(completed.map((c) => c.name));
  for (const run of pendingByName.values()) {
    if (seenNames.has(run.fixture_name)) continue;
    const meta = run.partial_report?.analyzer?.metadata ?? {};
    const summary = run.partial_report?.summary ?? {};
    const outcome = run.status === "failed" ? "failed"
      : run.status === "cancelled" ? "cancelled"
      : run.status === "negotiating" ? "negotiating"
      : null;
    inflight.push({
      name: run.fixture_name,
      modified: run.approved_at ?? run.created_at ?? Date.now(),
      provider_name: meta.provider_name ?? null,
      patient_name: meta.patient_name ?? null,
      date_of_service: meta.date_of_service ?? null,
      original_balance: summary.original_balance ?? null,
      final_balance: summary.final_balance ?? null,
      patient_saved: summary.patient_saved ?? null,
      channel_used: run.partial_report?.strategy?.chosen ?? null,
      outcome,
      defensible_disputed: summary.defensible_disputed ?? null,
      findings_count: run.partial_report?.analyzer?.errors?.length ?? 0,
      has_letter: false,
      status: (run.status ?? "audited") as "completed" | "negotiating" | "failed" | "cancelled" | "audited",
      run_id: run.run_id,
      contact: run.contact ?? null,
      can_launch: hasContactChannel(run.contact ?? null),
      bill_kind: (run.contact?.bill_kind ?? meta.bill_kind ?? "medical") as string,
      outcome_verified: run.outcome_verified ?? null,
      outcome_notes: run.outcome_notes ?? null,
      outcome_verified_at: run.outcome_verified_at ?? null,
      needs_outcome_check: false,
    });
  }

  const audits = [...completed, ...inflight].sort((a, b) => b.modified - a.modified);

  const letters = entries
    .filter((f) => f.startsWith("appeal-") && f.endsWith(".md"))
    .map((f) => {
      const name = f.slice("appeal-".length, -".md".length);
      const stat = statSync(join(outDir, f));
      return { name, modified: stat.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);

  return Response.json({ audits, letters });
}

async function handleReceipts(): Promise<Response> {
  const { readdirSync, statSync } = await import("node:fs");
  const outDir = currentUserPaths().reportsDir;
  if (!existsSync(outDir)) {
    return Response.json({ rows: [], total_saved: 0, count: 0 });
  }
  const entries = readdirSync(outDir).filter(
    (f) => f.startsWith("report-") && f.endsWith(".json"),
  );
  const rows: Array<{
    name: string;
    completed_at: number;
    provider_name: string | null;
    patient_name: string | null;
    date_of_service: string | null;
    original_balance: number | null;
    final_balance: number | null;
    patient_saved: number;
    channel_used: string | null;
    outcome: string | null;
    source_quote: string | null;
    defensible_disputed: number | null;
    thread_id: string | null;
  }> = [];
  let total_saved = 0;
  for (const f of entries) {
    const name = f.slice("report-".length, -".json".length);
    const full = join(outDir, f);
    let report: any = null;
    try {
      report = JSON.parse(readFileSync(full, "utf-8"));
    } catch {
      continue;
    }
    const summary = report?.summary ?? {};
    const meta = report?.analyzer?.metadata ?? {};
    const rawSaved = Number(summary.patient_saved ?? 0);
    const original = Number(summary.original_balance ?? 0);
    // Defensive clamp: even if a legacy report has saved > original
    // (which can't happen physically), display it as bounded. New runs
    // already clamp at the orchestrator; this protects pre-fix data.
    const saved = Math.max(0, Math.min(rawSaved, original > 0 ? original : rawSaved));
    if (!Number.isFinite(saved) || saved <= 0) continue;
    // Source quote: pick the highest-impact HIGH-confidence finding's
    // line_quote — the dollar tied to the receipt should trace back to
    // a real verbatim quote per the grounding contract.
    const errors: Array<{ confidence?: string; line_quote?: string; dollar_impact?: number }> =
      report?.analyzer?.errors ?? [];
    const top = errors
      .filter((e) => e.confidence === "high")
      .sort((a, b) => (b.dollar_impact ?? 0) - (a.dollar_impact ?? 0))[0];
    const stat = statSync(full);
    rows.push({
      name,
      completed_at: stat.mtimeMs,
      provider_name: meta.provider_name ?? null,
      patient_name: meta.patient_name ?? null,
      date_of_service: meta.date_of_service ?? null,
      original_balance: summary.original_balance ?? null,
      final_balance: summary.final_balance ?? null,
      patient_saved: saved,
      channel_used: summary.channel_used ?? null,
      outcome: summary.outcome ?? null,
      source_quote: top?.line_quote ?? null,
      defensible_disputed: summary.defensible_disputed ?? null,
      thread_id: report?.email_thread?.thread_id ?? null,
    });
    total_saved += saved;
  }
  rows.sort((a, b) => b.completed_at - a.completed_at);
  return Response.json({ rows, total_saved, count: rows.length });
}

async function handleReport(name: string): Promise<Response> {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== name) return Response.json({ error: "Bad name" }, { status: 400 });
  const full = currentUserPaths().reportPath(safe);
  if (!existsSync(full)) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(readFileSync(full, "utf-8"), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleLetter(name: string): Promise<Response> {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== name) return Response.json({ error: "Bad name" }, { status: 400 });
  const full = currentUserPaths().appealPath(safe);
  if (!existsSync(full)) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(readFileSync(full, "utf-8"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

async function handleOfferHunt(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    baseline?: Baseline;
    stop_on_first_win?: boolean;
  };
  if (!body.baseline || typeof body.baseline.current_price !== "number") {
    return Response.json({ error: "Missing or invalid baseline" }, { status: 400 });
  }
  const result = await runOfferHunt({
    baseline: body.baseline,
    stop_on_first_win: body.stop_on_first_win ?? true,
  });
  const saved_as = saveOfferHunt(result);
  return Response.json({ ...result, saved_as });
}

async function handleOfferSources(): Promise<Response> {
  // Surface the source directory so the UI can list who gets contacted.
  const summary = Object.entries(OFFER_SOURCE_DIRECTORY).map(([category, sources]) => ({
    category: category as OfferCategory,
    sources: sources.map((s) => ({ id: s.id, name: s.name, channel: s.channel })),
  }));
  return Response.json({ categories: summary });
}

async function handleOfferHistory(): Promise<Response> {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const dir = offersDir();
  if (!existsSync(dir)) return Response.json({ runs: [] });
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const runs = files
    .map((f) => {
      const full = join(dir, f);
      try {
        const j = JSON.parse(readFileSync(full, "utf8"));
        const st = statSync(full);
        return {
          file: f,
          modified: st.mtimeMs,
          baseline_label: j.baseline?.label ?? f,
          category: j.baseline?.category ?? "?",
          outcome: j.outcome,
          headline: j.headline,
          current_price: j.baseline?.current_price ?? null,
          best_price: j.best?.quoted_price ?? null,
          total_monthly_savings: j.total_monthly_savings ?? null,
          quotes_count: j.quotes?.length ?? 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.modified - a.modified);
  return Response.json({ runs });
}

async function handleOfferRun(file: string): Promise<Response> {
  const safe = file.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe !== file) return Response.json({ error: "Bad filename" }, { status: 400 });
  const full = join(offersDir(), safe);
  if (!existsSync(full)) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(readFileSync(full, "utf-8"), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleSaveProfile(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    dob?: string | null;
    ssn_last4?: string | null;
    drivers_license?: string | null;
    authorized?: boolean;
    hipaa_acknowledged?: boolean;
  };
  const { setProfileConfig, getProfileConfig } = await import("./lib/user-settings.ts");
  setProfileConfig({
    first_name: body.first_name ?? undefined,
    last_name: body.last_name ?? undefined,
    email: body.email ?? undefined,
    phone: body.phone ?? undefined,
    address: body.address ?? undefined,
    dob: body.dob ?? undefined,
    ssn_last4: body.ssn_last4 ?? undefined,
    drivers_license: body.drivers_license ?? undefined,
    authorized: body.authorized,
    hipaa_acknowledged: body.hipaa_acknowledged,
  });
  return Response.json({ ok: true, profile: getProfileConfig() });
}

async function handleExport(): Promise<Response> {
  const { readdirSync } = await import("node:fs");
  const outDir = currentUserPaths().reportsDir;
  const dump: {
    exported_at: string;
    profile: unknown;
    tune: unknown;
    bills: unknown[];
    reports: Record<string, unknown>;
    appeals: Record<string, string>;
  } = {
    exported_at: new Date().toISOString(),
    profile: null,
    tune: null,
    bills: [],
    reports: {},
    appeals: {},
  };
  try {
    const { getProfileConfig, getTuneConfig } = await import("./lib/user-settings.ts");
    dump.profile = getProfileConfig();
    dump.tune = getTuneConfig();
  } catch (err) {
    console.warn("[export] settings load failed", err);
  }
  if (existsSync(pendingDir())) {
    for (const name of readdirSync(pendingDir())) {
      if (!name.endsWith(".json")) continue;
      try {
        dump.bills.push(JSON.parse(readFileSync(join(pendingDir(), name), "utf-8")));
      } catch (err) {
        console.warn("[export] bad pending file", name, err);
      }
    }
  }
  if (existsSync(outDir)) {
    for (const name of readdirSync(outDir)) {
      if (name.startsWith("report-") && name.endsWith(".json")) {
        try {
          dump.reports[name] = JSON.parse(readFileSync(join(outDir, name), "utf-8"));
        } catch (err) {
          console.warn("[export] bad report file", name, err);
        }
      } else if (name.startsWith("appeal-") && name.endsWith(".md")) {
        dump.appeals[name] = readFileSync(join(outDir, name), "utf-8");
      }
    }
  }
  return new Response(JSON.stringify(dump, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="bonsai-export-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`,
    },
  });
}

async function handleDeleteAccount(req: Request, user: User): Promise<Response> {
  // Server-side confirmation guard. Without this, any browser tab on localhost
  // could drive-by wipe the user's data via a single fetch. The body is the
  // only thing that distinguishes an intentional delete from a CSRF.
  let body: { confirm?: string };
  try {
    body = (await req.json()) as { confirm?: string };
  } catch {
    return Response.json({ error: "Missing confirmation body" }, { status: 400 });
  }
  if (body.confirm !== "DELETE") {
    return Response.json({ error: "Confirmation required" }, { status: 400 });
  }
  const { rmSync } = await import("node:fs");
  // Nuke the entire per-user tree — single dir, no cherry-picking required.
  const baseDir = userOutDir();
  if (existsSync(baseDir)) {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch (err) {
      console.warn("[delete-account] rm user tree failed", baseDir, err);
    }
  }
  // Drop the user row + all their sessions from the auth db.
  deleteAllSessionsForUser(user.id);
  deleteUser(user.id);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": clearSessionCookieHeader(),
    },
  });
}

async function handleSaveTune(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    tone?: "polite" | "firm" | "aggressive";
    channels?: { email?: boolean; voice?: boolean };
    floor_pct?: number;
    email_digest?: boolean;
    mobile_alerts?: boolean;
  };
  const { setTuneConfig, getTuneConfig } = await import("./lib/user-settings.ts");
  setTuneConfig({
    tone: body.tone,
    channels: body.channels,
    floor_pct: body.floor_pct,
    email_digest: body.email_digest,
    mobile_alerts: body.mobile_alerts,
  });
  return Response.json({ ok: true, tune: getTuneConfig() });
}

// Anthropic keys look like `sk-ant-api03-...` (40+ chars). The onboarding
// placeholder ending in "..." is a common false positive — treat it as unset.
function looksLikeRealApiKey(v: string | undefined | null): boolean {
  if (!v) return false;
  const t = v.trim();
  if (!t) return false;
  if (t.endsWith("...")) return false;
  return t.length >= 16;
}
function last4(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length > 4 ? t.slice(-4) : null;
}

async function handleSettings(): Promise<Response> {
  const { getProfileConfig, getTuneConfig, getIntegrationsConfig } = await import("./lib/user-settings.ts");
  const profile = getProfileConfig();
  const tune = getTuneConfig();
  const stored = getIntegrationsConfig();

  const envVal = (k: string): string | undefined => {
    const v = process.env[k];
    return v && v.length > 0 ? v : undefined;
  };
  // Effective value: the one the running agent actually uses. Stored wins
  // because applyIntegrationsToEnv() copies it into process.env on save.
  const eff = {
    anthropic_api_key: stored.anthropic_api_key ?? envVal("ANTHROPIC_API_KEY") ?? null,
    resend_api_key: stored.resend_api_key ?? envVal("RESEND_API_KEY") ?? null,
    resend_from: stored.resend_from ?? envVal("RESEND_FROM") ?? envVal("RESEND_FROM_EMAIL") ?? null,
    elevenlabs_api_key: stored.elevenlabs_api_key ?? envVal("ELEVENLABS_API_KEY") ?? null,
    elevenlabs_agent_id: stored.elevenlabs_agent_id ?? envVal("ELEVENLABS_AGENT_ID") ?? null,
    elevenlabs_webhook_base: stored.elevenlabs_webhook_base ?? envVal("ELEVENLABS_WEBHOOK_BASE") ?? null,
  };

  const anthropicConnected = looksLikeRealApiKey(eff.anthropic_api_key);
  const resendConnected = looksLikeRealApiKey(eff.resend_api_key);
  const elevenConnected = looksLikeRealApiKey(eff.elevenlabs_api_key);

  return Response.json({
    profile,
    tune,
    // Operator-managed services (Anthropic Claude + Resend email) live in
    // the host's env vars now — every user shares the same operator-paid
    // analysis + the same verified sending domain. Hidden from the user
    // because there's nothing for them to configure. Voice (ElevenLabs)
    // stays per-user since it's optional and per-account.
    integrations: [
      {
        key: "elevenlabs",
        label: "ElevenLabs (call)",
        status: elevenConnected ? "connected" : "missing",
        detail: elevenConnected
          ? `Agent ID ${eff.elevenlabs_agent_id ?? "(unset — create via client.createAgent())"}.`
          : "Optional — connects voice negotiation. Until connected, voice flows run the dual-Claude simulator.",
        required: false,
        fields: [
          { name: "elevenlabs_api_key", label: "API key", kind: "secret", last4: last4(eff.elevenlabs_api_key), from_user: !!stored.elevenlabs_api_key },
          { name: "elevenlabs_agent_id", label: "Agent ID", kind: "text", value: eff.elevenlabs_agent_id ?? "", placeholder: "agent_xxxxxxxxxxxx", from_user: !!stored.elevenlabs_agent_id },
          { name: "elevenlabs_webhook_base", label: "Webhook base URL", kind: "text", value: eff.elevenlabs_webhook_base ?? "", placeholder: "https://your-tunnel.ngrok.app", from_user: !!stored.elevenlabs_webhook_base },
        ],
      },
    ],
    // Status of the operator-managed services, surfaced read-only so the
    // dashboard can show "Email delivery: live" without giving the user a
    // form to fill in.
    platform: {
      claude_ready: anthropicConnected,
      email_ready: resendConnected,
    },
    fixtures: {
      count: (await import("node:fs")).readdirSync(FIXTURES_DIR)
        .filter((f) => f.startsWith("bill-") && f.endsWith(".pdf")).length,
    },
    port: PORT,
  });
}

async function handleSaveIntegrations(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;
  const { setIntegrationsConfig, getIntegrationsConfig } = await import("./lib/user-settings.ts");
  const allowed = [
    "anthropic_api_key",
    "resend_api_key",
    "resend_from",
    "elevenlabs_api_key",
    "elevenlabs_agent_id",
    "elevenlabs_webhook_base",
  ] as const;
  const input: Partial<Record<(typeof allowed)[number], string>> = {};
  for (const k of allowed) {
    const v = body[k];
    if (typeof v === "string") input[k] = v;
  }
  setIntegrationsConfig(input);
  return Response.json({ ok: true, integrations: getIntegrationsConfig() });
}

// Settings-stored integration credentials are now per-user. They get
// pushed to process.env when the active user touches the settings page
// (see setIntegrationsConfig → applyIntegrationsToEnv). For a process-
// global default, set them in `.env` — that's what operators use to seed
// every fresh account on startup.

const PORT = Number(process.env.PORT ?? 3333);

// The sample-bill flow reads fixtures/<name>.pdf, but those PDFs are
// .gitignored build artifacts generated from fixtures/*.md by
// scripts/make-fixture-pdfs.ts. On a fresh clone they don't exist yet,
// which silently breaks the "Try a sample →" onboarding affordance.
// Regenerate any missing PDFs at startup so the feature auto-heals.
try {
  const { generateFixturePdfs } = await import("../scripts/make-fixture-pdfs.ts");
  const { generated } = await generateFixturePdfs({ onlyMissing: true });
  if (generated.length > 0) {
    console.log(`[fixtures] generated ${generated.length} PDF(s) from markdown: ${generated.join(", ")}`);
  }
} catch (err) {
  console.warn(
    "[fixtures] could not generate sample PDFs — 'Try a sample' may 404. " +
      "Install Google Chrome, or run `bun run make-pdfs` manually. Error:",
    (err as Error).message,
  );
}

// ─── Auth endpoints (unauthenticated) ─────────────────────────────
function userPublic(user: User): {
  id: string;
  email: string;
  accepted_terms_at: number | null;
  early_access_at: number | null;
} {
  return {
    id: user.id,
    email: user.email,
    accepted_terms_at: user.accepted_terms_at,
    early_access_at: user.early_access_at,
  };
}

async function handleJoinEarlyAccess(user: User): Promise<Response> {
  const { joinEarlyAccess } = await import("./lib/auth.ts");
  const updated = joinEarlyAccess(user.id);
  return Response.json({ user: userPublic(updated) });
}

async function handleLeaveEarlyAccess(user: User): Promise<Response> {
  const { leaveEarlyAccess } = await import("./lib/auth.ts");
  const updated = leaveEarlyAccess(user.id);
  return Response.json({ user: userPublic(updated) });
}

async function handleSignup(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { email?: string; password?: string; accepted_terms?: boolean }
    | null;
  if (!body?.email || !body?.password) {
    return Response.json({ error: "Missing email or password" }, { status: 400 });
  }
  try {
    const user = await createUser(body.email, body.password, {
      acceptedTerms: !!body.accepted_terms,
    });
    const session = createSession(user.id);
    ensureUserDirs(userPaths(user.id));
    // Seed the profile email with the account email so the agent's CC +
    // inbound-forward features fire for day-one users without them having
    // to find the Profile tab. Wrapped in withUserContext because
    // setProfileConfig resolves the per-user settings file via the ALS
    // store. User can still overwrite it in Settings → Profile later.
    await withUserContext(user, async () => {
      const { setProfileConfig } = await import("./lib/user-settings.ts");
      setProfileConfig({ email: user.email });
    });
    return new Response(JSON.stringify({ user: userPublic(user) }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": setSessionCookieHeader(session.id),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}

async function handleLogin(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) {
    return Response.json({ error: "Missing email or password" }, { status: 400 });
  }
  try {
    const user = await verifyCredentials(body.email, body.password);
    const session = createSession(user.id);
    ensureUserDirs(userPaths(user.id));
    return new Response(JSON.stringify({ user: userPublic(user) }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": setSessionCookieHeader(session.id),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message, code: err.code }, { status: 401 });
    }
    throw err;
  }
}

async function handleLogout(req: Request): Promise<Response> {
  const token = readSessionCookie(req);
  if (token) deleteSession(token);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": clearSessionCookieHeader(),
    },
  });
}

/**
 * Send a password-reset email via Resend, when configured. Returns true if
 * the email was actually dispatched, false if Resend isn't set up (caller
 * falls back to logging the link to the server console for dev).
 */
/**
 * Generic Resend transactional-email sender for non-negotiation flows
 * (password reset, email verification, etc.). Returns true when the API
 * accepted the message; false when Resend isn't configured or the call
 * failed — caller is responsible for the dev-log fallback in that case.
 */
async function sendTransactionalEmailViaResend(opts: {
  to: string;
  subject: string;
  text: string;
  scope?: string; // tag for log lines, e.g. "forgot" / "verify"
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return false;
  const tag = opts.scope ?? "transactional";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
      }),
    });
    if (!res.ok) {
      console.warn(`[${tag}] Resend rejected request:`, res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[${tag}] Resend send failed:`, (err as Error).message);
    return false;
  }
}

async function sendResetEmailViaResend(toEmail: string, link: string): Promise<boolean> {
  return sendTransactionalEmailViaResend({
    to: toEmail,
    subject: "Reset your Bonsai password",
    scope: "forgot",
    text: [
      "Someone — hopefully you — asked to reset the password on your Bonsai account.",
      "",
      "Click the link below to set a new one. It expires in one hour.",
      "",
      link,
      "",
      "If you didn't request this, just ignore the email.",
    ].join("\n"),
  });
}

async function handleForgotPassword(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim();
  if (!email) return Response.json({ error: "Missing email" }, { status: 400 });
  // Per-email cap. Keying on the requested email (not IP) matches the abuse
  // model — we care about per-account harassment, not per-IP signup floods.
  const rl = rateLimit({
    key: `forgot:${email.toLowerCase()}`,
    max: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.ok) {
    return rateLimitResponse(
      rl.retryAfterSec,
      "Too many reset requests for this email. Try again later.",
    );
  }
  const user = getUserByEmail(email);
  // Don't leak whether the email is on file. Always look like we sent
  // something — only the dev-mode hint differs.
  if (!user) {
    return Response.json({ ok: true });
  }
  const reset = createPasswordResetToken(user.id);
  const url = new URL(req.url);
  // Build the link off the request's own host so dev (localhost:3344),
  // ngrok tunnels, and production all produce a working link.
  const link = `${url.protocol}//${url.host}/app?reset=${encodeURIComponent(reset.token)}`;
  const sent = await sendResetEmailViaResend(user.email, link);
  if (!sent) {
    // Resend isn't wired — surface the link in the server log so the
    // developer can grab it. Front-end shows a hint when dev_link is true.
    console.log(`[forgot] dev reset link for ${user.email}: ${link}`);
    return Response.json({ ok: true, dev_link: true });
  }
  return Response.json({ ok: true });
}

async function handleResetPassword(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { token?: string; password?: string } | null;
  if (!body?.token || !body?.password) {
    return Response.json({ error: "Missing token or password" }, { status: 400 });
  }
  try {
    const user = await consumePasswordResetToken(body.token, body.password);
    // Password is reset and every old session was cleared as part of the
    // transaction. Mint a fresh session so the user lands logged in.
    const session = createSession(user.id);
    ensureUserDirs(userPaths(user.id));
    return new Response(JSON.stringify({ user: { id: user.id, email: user.email } }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": setSessionCookieHeader(session.id),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}

function handleMe(user: User | null): Response {
  if (!user) return Response.json({ user: null }, { status: 200 });
  return Response.json({ user: userPublic(user) });
}

const PUBLIC_API_PATHS = new Set([
  "/api/auth/signup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/auth/forgot",
  "/api/auth/reset",
]);

// Fail-fast on missing required env. The Anthropic SDK only complains
// when the first audit fires, which is a confusing place for a "missing
// API key" error to land. Catch it at boot so the operator gets a clear
// pointer to .env.example instead of a stack trace at request time.
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\n[bonsai] Refusing to start: ANTHROPIC_API_KEY is not set.\n" +
      "  Bun reads `.env` from the project root automatically. Either:\n" +
      "    1. Copy `.env.example` to `.env` and fill in your real key, or\n" +
      "    2. `export ANTHROPIC_API_KEY=...` in your shell.\n" +
      "  Get a key at https://console.anthropic.com/.\n",
  );
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  // Bind to all interfaces so Railway's edge proxy (and any other
  // reverse-proxy / container-orchestrator setup) can reach the listener.
  // Bun's default should already be 0.0.0.0, but setting it explicitly
  // forecloses the "deploy is ACTIVE but every request 502s" mystery on
  // Railway specifically.
  hostname: "0.0.0.0",
  idleTimeout: 240,
  async fetch(req, server) {
    const url = new URL(req.url);
    try {
      // Liveness probe for Railway / any platform health check. Cheap and
      // public — never gated on auth so the platform's checker doesn't
      // need credentials. Returns 200 as long as the event loop is alive.
      if (req.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok", { headers: { "Content-Type": "text/plain" } });
      }
      // Auth endpoints first — these run without a session.
      if (req.method === "POST" && url.pathname === "/api/auth/signup") {
        const ip = getClientIp(req, server);
        const rl = rateLimit({
          key: `signup:ip:${ip}`,
          max: 10,
          windowMs: 60 * 60 * 1000,
        });
        if (!rl.ok) {
          return rateLimitResponse(
            rl.retryAfterSec,
            "Too many signups from this address. Try again later.",
          );
        }
        return handleSignup(req);
      }
      if (req.method === "POST" && url.pathname === "/api/auth/login") return handleLogin(req);
      if (req.method === "POST" && url.pathname === "/api/auth/logout") return handleLogout(req);
      if (req.method === "GET" && url.pathname === "/api/auth/me") return handleMe(requireUser(req));
      if (req.method === "POST" && url.pathname === "/api/auth/forgot") return handleForgotPassword(req);
      if (req.method === "POST" && url.pathname === "/api/auth/reset") return handleResetPassword(req);

      // Resend's inbound webhook is unauthenticated — it carries an svix
      // HMAC signature instead of a session cookie. Lives outside the auth
      // gate so the email rep's reply lands without a 401.
      if (req.method === "POST" && url.pathname === "/webhooks/resend-inbound") {
        const { handleResendInbound } = await import("./server/webhooks.ts");
        return handleResendInbound(req);
      }
      if (req.method === "POST" && url.pathname === "/webhooks/resend-inbound/echo") {
        const { handleResendInboundEcho } = await import("./server/webhooks.ts");
        return handleResendInboundEcho(req);
      }

      // Static pages render unauthenticated; the front-end calls /api/auth/me
      // and switches to the login screen when no user is returned.
      if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
        return handleStatic(url.pathname);
      }

      // Every /api/* route past this point requires a session.
      if (PUBLIC_API_PATHS.has(url.pathname)) {
        return new Response("Not found", { status: 404 });
      }
      const user = requireUser(req);
      if (!user) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      // Make sure the user's tree exists (cheap, idempotent) — nothing
      // downstream will succeed without it.
      ensureUserDirs(userPaths(user.id));

      return await withUserContext(user, async () => {
        if (req.method === "GET" && url.pathname === "/api/fixtures") return handleListFixtures();
        if (req.method === "GET" && url.pathname === "/api/history") return handleHistory();
        if (req.method === "GET" && url.pathname === "/api/receipts") return handleReceipts();
        if (req.method === "GET" && url.pathname === "/api/settings") return handleSettings();
        if (req.method === "POST" && url.pathname === "/api/settings/profile") return handleSaveProfile(req);
        if (req.method === "POST" && url.pathname === "/api/settings/tune") return handleSaveTune(req);
        if (req.method === "POST" && url.pathname === "/api/settings/integrations") return handleSaveIntegrations(req);
        if (req.method === "GET" && url.pathname === "/api/export") return handleExport();
        if (req.method === "POST" && url.pathname === "/api/account/delete") return handleDeleteAccount(req, user);
        if (req.method === "GET" && url.pathname === "/api/offer-sources") return handleOfferSources();
        if (req.method === "GET" && url.pathname === "/api/offer-history") return handleOfferHistory();
        if (req.method === "POST" && url.pathname === "/api/offer-hunt") return handleOfferHunt(req);
        const offerRunMatch = url.pathname.match(/^\/api\/offer-run\/([a-zA-Z0-9._-]+)$/);
        if (req.method === "GET" && offerRunMatch) return handleOfferRun(offerRunMatch[1]);
        const reportMatch = url.pathname.match(/^\/api\/report\/([a-zA-Z0-9_-]+)$/);
        if (req.method === "GET" && reportMatch) return handleReport(reportMatch[1]);
        const letterMatch = url.pathname.match(/^\/api\/letter\/([a-zA-Z0-9_-]+)$/);
        if (req.method === "GET" && letterMatch) return handleLetter(letterMatch[1]);
        if (req.method === "POST" && url.pathname === "/api/run-fixture") return handleRunFixture(req);
        if (req.method === "POST" && url.pathname === "/api/run") return handleUpload(req);
        if (req.method === "POST" && url.pathname === "/api/thumbnail") return handleThumbnail(req);
        if (req.method === "POST" && url.pathname === "/api/audit") return handleAudit(req);
        if (req.method === "POST" && url.pathname === "/api/complaint") return handleComplaint(req);
        if (req.method === "POST" && url.pathname === "/api/complaint/chat") return handleComplaintChat(req);
        if (req.method === "POST" && url.pathname === "/api/ask") return handleAsk(req);
        if (req.method === "POST" && url.pathname === "/api/plan-chat") return handlePlanChat(req);
        if (req.method === "POST" && url.pathname === "/api/opportunities") return handleOpportunities(req);
        if (req.method === "POST" && url.pathname === "/api/approve") return handleApprove(req);
        if (req.method === "POST" && url.pathname === "/api/stop") return handleStopNegotiation(req);
        if (req.method === "POST" && url.pathname === "/api/resume") return handleResumeNegotiation(req);
        if (req.method === "POST" && url.pathname === "/api/delete") return handleDeleteBill(req);
        if (req.method === "POST" && url.pathname === "/api/feedback") return handleFeedback(req);
        if (req.method === "POST" && url.pathname === "/api/bills/verify-outcome") return handleVerifyOutcome(req);
        if (req.method === "POST" && url.pathname === "/api/early-access") return handleJoinEarlyAccess(user);
        if (req.method === "DELETE" && url.pathname === "/api/early-access") return handleLeaveEarlyAccess(user);
        const feedbackMatch = url.pathname.match(/^\/api\/feedback\/([a-zA-Z0-9_-]+)$/);
        if (req.method === "GET" && feedbackMatch) return handleGetFeedback(feedbackMatch[1]);
        const contactStatusMatch = url.pathname.match(/^\/api\/contact\/([a-zA-Z0-9_-]+)$/);
        if (req.method === "GET" && contactStatusMatch) return handleContactStatus(contactStatusMatch[1]);
        if (req.method === "POST" && url.pathname === "/api/contact/override") return handleContactOverride(req);
        if (req.method === "POST" && url.pathname === "/api/contact/retry") return handleContactRetry(req);
        // Per-bill user-typed contact (Contact tab in the drawer). Distinct
        // from /api/contact/:run_id above which surfaces the web-search
        // resolver's status.
        const billContactMatch = url.pathname.match(/^\/api\/bill\/([a-zA-Z0-9_-]+)\/contact$/);
        if (billContactMatch) {
          if (req.method === "GET") return handleGetContact(billContactMatch[1]);
          if (req.method === "POST" || req.method === "PATCH") return handleSetContact(req, billContactMatch[1]);
        }
        const billListMatch = url.pathname.match(/^\/api\/bill\/([a-zA-Z0-9_-]+)$/);
        if (req.method === "GET" && billListMatch) return handleListBill(billListMatch[1]);
        const billViewMatch = url.pathname.match(/^\/api\/bill\/([a-zA-Z0-9_-]+)\/(\d+)$/);
        if (req.method === "GET" && billViewMatch)
          return handleViewBill(billViewMatch[1], billViewMatch[2]);
        return new Response("Method not allowed", { status: 405 });
      });
    } catch (err) {
      console.error("server error:", err);
      return Response.json(
        { error: (err as Error).message, stack: (err as Error).stack },
        { status: 500 },
      );
    }
  },
});

console.log(`Bonsai server listening on http://localhost:${server.port}`);

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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
import { normalizeBillFile } from "./lib/extract-bill.ts";
import { transcribeBill } from "./lib/transcribe-bill.ts";
import { groundTruthFromText } from "./lib/ground-truth.ts";
import type { AnalyzeInput } from "./lib/fixture-audit.ts";
import type { Persona as EmailPersona } from "./simulate-reply.ts";
import type { RepPersona as VoicePersona } from "./voice/simulator.ts";
import type { SmsPersona } from "./simulate-sms-reply.ts";
import {
  runOfferHunt,
  saveOfferHunt,
  offersDir,
  OFFER_SOURCE_DIRECTORY,
  type Baseline,
  type OfferCategory,
} from "./offer-agent.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIXTURES_DIR = join(ROOT, "fixtures");
const UPLOAD_DIR = join(ROOT, "out", "uploads");
const PUBLIC_DIR = join(ROOT, "public");

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
    sms_persona?: SmsPersona;
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
    sms_persona: body.sms_persona,
  });
  mkdirSync(join(ROOT, "out"), { recursive: true });
  writeFileSync(join(ROOT, "out", `report-${billName}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, "out", `appeal-${billName}.md`), report.appeal.markdown);
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

const PENDING_DIR = join(ROOT, "out", "pending");

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
  sms_persona?: SmsPersona;
  partial_report: BonsaiReport;
  plan_edits?: string; // accumulated natural-language directives for negotiation agents
  plan_chat?: Array<{ role: "user" | "assistant"; body: string; ts: string }>;
  qa: Array<{ q: string; a: string; ts: string }>;
  created_at: number;
}

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
  return join(PENDING_DIR, `${safe}.json`);
}

function savePending(run: PendingRun): void {
  mkdirSync(PENDING_DIR, { recursive: true });
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
  let sms_persona: SmsPersona | undefined;
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
      sms_persona?: SmsPersona;
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
    sms_persona = body.sms_persona;
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
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const uploadId = `upload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const billPaths: string[] = [];
    const billNames: string[] = [];
    for (let i = 0; i < billFiles.length; i++) {
      const f = billFiles[i];
      const ext = extensionOf(f.name) ?? "bin";
      const p = join(UPLOAD_DIR, `${uploadId}-bill-${i + 1}.${ext}`);
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
      eobPath = join(UPLOAD_DIR, `${uploadId}-eob.${eobExt}`);
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

  const partial = await runAuditPhase({
    billPdfPath: billPath,
    eobPdfPath: eobPath,
    billFixtureName: fixtureName,
    analyzeInput,
    channel,
    email_persona,
    voice_persona,
    sms_persona,
  });

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
    sms_persona,
    partial_report: partial,
    qa: [],
    created_at: Date.now(),
  };
  savePending(run);
  return Response.json({ run_id: run.run_id, report: partial });
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
      model: "claude-sonnet-4-5",
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
    "You are Bonsai, helping the user refine the negotiation plan of attack before we contact the provider.",
    "Tone: terse, direct, one small step at a time. The user is iterating — don't dump the whole plan, just respond to what they asked.",
    "",
    "Reply via the update_plan tool call (no prose outside the tool). The tool has four fields:",
    "- chat_reply: 1-2 sentences acknowledging the change and asking what's next.",
    "- strategy_chosen: one of email / voice / sms / persistent. Pick the channel that matches the user's intent. Default to the existing channel if the user didn't explicitly change it.",
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
        strategy_chosen: { type: "string", enum: ["email", "voice", "sms", "persistent"] },
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
      strategy_chosen: "email" | "voice" | "sms" | "persistent";
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

async function handleApprove(req: Request): Promise<Response> {
  const body = (await req.json()) as { run_id?: string; plan_edits?: string };
  if (!body.run_id) return Response.json({ error: "Missing run_id" }, { status: 400 });
  const run = loadPending(body.run_id);
  if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404 });

  if (body.plan_edits) {
    run.plan_edits = body.plan_edits;
    // Echo user edits into the strategy rationale so they show up in the final report.
    run.partial_report.strategy.reason =
      `${run.partial_report.strategy.reason}\n\nUser edits: ${body.plan_edits}`;
    savePending(run);
  }

  const full = await runNegotiationPhase(run.partial_report, {
    billPdfPath: run.bill_path,
    eobPdfPath: run.eob_path,
    billFixtureName: run.fixture_name,
    channel: run.channel,
    email_persona: run.email_persona,
    voice_persona: run.voice_persona,
    sms_persona: run.sms_persona,
  });

  mkdirSync(join(ROOT, "out"), { recursive: true });
  writeFileSync(join(ROOT, "out", `report-${run.fixture_name}.json`), JSON.stringify(full, null, 2));
  writeFileSync(join(ROOT, "out", `appeal-${run.fixture_name}.md`), full.appeal.markdown);
  // Clean up pending state — the run is done.
  try { readFileSync(pendingPath(run.run_id)); writeFileSync(pendingPath(run.run_id), JSON.stringify({ ...run, partial_report: full, completed_at: Date.now() }, null, 2)); } catch {}

  return Response.json(full);
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
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const uploadId = `upload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const billPath = join(UPLOAD_DIR, `${uploadId}-bill.pdf`);
  writeFileSync(billPath, new Uint8Array(await billFile.arrayBuffer()));

  // NOTE: real user uploads won't have a markdown ground truth; the grounding
  // check would need to extract text from the uploaded PDF. For the hackathon
  // demo, uploads must match a shipped fixture name (e.g. user uploads the
  // same bill-001.pdf we ship). We surface this in the error message.
  // A follow-up would wire in `unpdf` to extract text from the uploaded PDF.
  const baseName = billFile.name.replace(/\.pdf$/i, "");
  const groundTruthPath = join(FIXTURES_DIR, `${baseName}.md`);
  if (!existsSync(groundTruthPath)) {
    return Response.json(
      {
        error:
          "Uploaded bill doesn't have a matching ground-truth markdown fixture. For the demo, upload bill-001.pdf or a file named to match a shipped fixture. Live PDF text extraction is a follow-up.",
        hint: `Expected fixtures/${baseName}.md`,
      },
      { status: 400 },
    );
  }

  // Resolve an EOB source: prefer the uploaded file, then the shipped fixture
  // that matches this bill name. Medical audits need the EOB for cross-reference;
  // if neither exists, surface a clear error.
  let eobPath: string | null = null;
  if (eobFile) {
    eobPath = join(UPLOAD_DIR, `${uploadId}-eob.pdf`);
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

  const report = await runBonsai({
    billPdfPath: billPath,
    eobPdfPath: eobPath,
    billFixtureName: baseName,
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
  if (!path.startsWith(UPLOAD_DIR) && !path.startsWith(FIXTURES_DIR)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!existsSync(path)) return Response.json({ error: "File missing on disk" }, { status: 404 });
  const ext = extensionOf(path) ?? "bin";
  const name = run.bill_names[index] ?? basename(path);
  return new Response(readFileSync(path), {
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
  let path = pathname === "/" ? "/index.html" : pathname;
  const fsPath = join(PUBLIC_DIR, path);
  if (!existsSync(fsPath)) return new Response("Not found", { status: 404 });
  // naive path traversal guard: must start with PUBLIC_DIR
  const resolved = fsPath;
  if (!resolved.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
  return new Response(readFileSync(resolved), {
    headers: { "Content-Type": contentType(path) },
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
  const outDir = join(ROOT, "out");
  if (!existsSync(outDir)) return Response.json({ audits: [], letters: [] });
  const entries = readdirSync(outDir);

  const audits = entries
    .filter((f) => f.startsWith("report-") && f.endsWith(".json"))
    .map((f) => {
      const name = f.slice("report-".length, -".json".length);
      const full = join(outDir, f);
      let report: any = null;
      try { report = JSON.parse(readFileSync(full, "utf-8")); } catch { /* ignore */ }
      const stat = statSync(full);
      const summary = report?.summary ?? {};
      const meta = report?.analyzer?.metadata ?? {};
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
      };
    })
    .sort((a, b) => b.modified - a.modified);

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

async function handleReport(name: string): Promise<Response> {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== name) return Response.json({ error: "Bad name" }, { status: 400 });
  const full = join(ROOT, "out", `report-${safe}.json`);
  if (!existsSync(full)) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(readFileSync(full, "utf-8"), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleLetter(name: string): Promise<Response> {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== name) return Response.json({ error: "Bad name" }, { status: 400 });
  const full = join(ROOT, "out", `appeal-${safe}.md`);
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

async function handleSettings(): Promise<Response> {
  const has = (k: string) => Boolean(process.env[k] && process.env[k]!.length > 0);
  return Response.json({
    integrations: [
      {
        key: "anthropic",
        label: "Anthropic Claude",
        status: has("ANTHROPIC_API_KEY") ? "connected" : "missing",
        detail: has("ANTHROPIC_API_KEY")
          ? "Sonnet 4.5 powering analyzer + negotiation loops."
          : "Set ANTHROPIC_API_KEY in .env. Required.",
        env: ["ANTHROPIC_API_KEY"],
        required: true,
      },
      {
        key: "resend",
        label: "Resend (email)",
        status: has("RESEND_API_KEY") ? "connected" : "simulated",
        detail: has("RESEND_API_KEY")
          ? `Outbound from ${process.env.RESEND_FROM ?? "(RESEND_FROM unset)"}. Inbound via simulator until webhook wired.`
          : "Email flows run against MockEmailClient — in-memory thread state, role-played replies.",
        env: ["RESEND_API_KEY", "RESEND_FROM"],
        required: false,
      },
      {
        key: "elevenlabs",
        label: "ElevenLabs (voice)",
        status: has("ELEVENLABS_API_KEY") ? "connected" : "simulated",
        detail: has("ELEVENLABS_API_KEY")
          ? `Agent ID ${process.env.ELEVENLABS_AGENT_ID ?? "(unset — create via client.createAgent())"}.`
          : "Voice flows run the dual-Claude simulator. Real tool-handlers dispatch either way.",
        env: ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_WEBHOOK_BASE"],
        required: false,
      },
      {
        key: "twilio",
        label: "Twilio (SMS)",
        status:
          has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN") && has("TWILIO_FROM_NUMBER")
            ? "connected"
            : "simulated",
        detail:
          has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN") && has("TWILIO_FROM_NUMBER")
            ? `Outbound from ${process.env.TWILIO_FROM_NUMBER}. Inbound via Messaging webhook.`
            : "SMS flows run against MockSmsClient — disk-backed thread, simulated billing-dept replies.",
        env: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
        required: false,
      },
    ],
    fixtures: {
      count: (await import("node:fs")).readdirSync(FIXTURES_DIR)
        .filter((f) => f.startsWith("bill-") && f.endsWith(".pdf")).length,
    },
    port: PORT,
  });
}

const PORT = Number(process.env.PORT ?? 3333);

const server = Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/api/fixtures") return handleListFixtures();
      if (req.method === "GET" && url.pathname === "/api/history") return handleHistory();
      if (req.method === "GET" && url.pathname === "/api/settings") return handleSettings();
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
      if (req.method === "POST" && url.pathname === "/api/audit") return handleAudit(req);
      if (req.method === "POST" && url.pathname === "/api/ask") return handleAsk(req);
      if (req.method === "POST" && url.pathname === "/api/plan-chat") return handlePlanChat(req);
      if (req.method === "POST" && url.pathname === "/api/approve") return handleApprove(req);
      const billListMatch = url.pathname.match(/^\/api\/bill\/([a-zA-Z0-9_-]+)$/);
      if (req.method === "GET" && billListMatch) return handleListBill(billListMatch[1]);
      const billViewMatch = url.pathname.match(/^\/api\/bill\/([a-zA-Z0-9_-]+)\/(\d+)$/);
      if (req.method === "GET" && billViewMatch)
        return handleViewBill(billViewMatch[1], billViewMatch[2]);
      if (req.method === "GET" || req.method === "HEAD") return handleStatic(url.pathname);
      return new Response("Method not allowed", { status: 405 });
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

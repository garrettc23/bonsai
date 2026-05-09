/**
 * Typed wrapper around the fact-check skill.
 *
 * Runs the cross-modal verifier on a drafted email body before it goes
 * to the humanizer. Two production behaviors:
 *
 *   1. Disabled by default — only runs when BONSAI_CROSSMODAL=1 is set.
 *      The flag is the gradual-rollout gate from the rebuild plan: ship
 *      the code, enable in staging, observe failure rates against
 *      grounded fixtures, then flip globally.
 *
 *   2. Fail-open — if the OpenAI call errors (no API key, rate limit,
 *      malformed tool output), we log a warning and report passed=true.
 *      Same principle as the humanizer at lib/humanizer.ts: we never
 *      block a send on an eval failure.
 */
import { runSkill } from "./skill-runner.ts";
import type { LLMTool, ProviderRunners } from "../../llm/provider.ts";

export type ViolationKind =
  | "missing_fact"
  | "wrong_amount"
  | "paraphrased"
  | "fabricated"
  | "other";

export interface FactCheckViolation {
  kind: ViolationKind;
  detail: string;
}

export interface FactCheckResult {
  passed: boolean;
  violations: FactCheckViolation[];
  /** True when the check was skipped (env gate off or fail-open path).
   * Lets the caller distinguish "GPT said it's fine" from "we didn't
   * actually look". */
  skipped: boolean;
}

const FACT_CHECK_TOOL: LLMTool = {
  name: "fact_check_report",
  description: "Report whether the draft preserves the grounded analyzer facts.",
  input_schema: {
    type: "object",
    required: ["passed", "violations"],
    properties: {
      passed: { type: "boolean" },
      violations: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "detail"],
          properties: {
            kind: {
              type: "string",
              enum: ["missing_fact", "wrong_amount", "paraphrased", "fabricated", "other"],
            },
            detail: { type: "string", minLength: 5 },
          },
        },
      },
    },
  },
};

export interface FactCheckOpts {
  draft_subject: string;
  draft_body: string;
  preserve_facts: string[];
  runners?: ProviderRunners;
}

export async function factCheck(opts: FactCheckOpts): Promise<FactCheckResult> {
  // Gradual-rollout gate. Off by default; ops flips this on per env.
  if (process.env.BONSAI_CROSSMODAL !== "1") {
    return { passed: true, violations: [], skipped: true };
  }
  const facts = formatPreserveFacts(opts.preserve_facts);
  try {
    const resp = await runSkill("fact-check", {
      vars: {
        preserve_facts: facts,
        draft_subject: opts.draft_subject,
        draft_body: opts.draft_body,
      },
      // The skill body has all the context the model needs; the user
      // message just kicks the call off so providers that require a
      // user role have one. Keep it short.
      user: "Run the fact-check now and return your decision via the fact_check_report tool.",
      tools: [FACT_CHECK_TOOL],
      runners: opts.runners,
    });
    if (!resp.tool_use || resp.tool_use.name !== "fact_check_report") {
      console.warn("[fact-check] no tool call in response — failing open");
      return { passed: true, violations: [], skipped: true };
    }
    const input = resp.tool_use.input as {
      passed?: unknown;
      violations?: unknown;
    };
    const passed = input.passed === true;
    const violations = parseViolations(input.violations);
    return { passed, violations, skipped: false };
  } catch (err) {
    console.warn(`[fact-check] failed, treating draft as passed: ${(err as Error).message}`);
    return { passed: true, violations: [], skipped: true };
  }
}

function formatPreserveFacts(facts: string[]): string {
  if (!facts.length) return "(none — analyzer surfaced no high-confidence facts to preserve)";
  return facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
}

function parseViolations(raw: unknown): FactCheckViolation[] {
  if (!Array.isArray(raw)) return [];
  const allowed: ReadonlySet<ViolationKind> = new Set([
    "missing_fact",
    "wrong_amount",
    "paraphrased",
    "fabricated",
    "other",
  ]);
  const out: FactCheckViolation[] = [];
  for (const v of raw) {
    if (typeof v !== "object" || v === null) continue;
    const obj = v as { kind?: unknown; detail?: unknown };
    const kind = typeof obj.kind === "string" && allowed.has(obj.kind as ViolationKind)
      ? (obj.kind as ViolationKind)
      : "other";
    const detail = typeof obj.detail === "string" ? obj.detail : "";
    if (detail.length < 1) continue;
    out.push({ kind, detail });
  }
  return out;
}

/** Format violations as a tool_result error string fed back to the
 * draft-reply LLM so it can redraft. Kept outside factCheck() because
 * the negotiate-email loop also wants to log the same string. */
export function violationsToFeedback(violations: FactCheckViolation[]): string {
  if (!violations.length) return "Fact-check passed.";
  const lines = violations.map((v, i) => `${i + 1}. [${v.kind}] ${v.detail}`);
  return [
    "Fact-check failed before send. The grounded facts list and your draft do not match.",
    "Violations:",
    ...lines,
    "Redraft the email and call send_email again with the corrected body. Quote analyzer facts verbatim — do NOT invent claim numbers or dollar figures, and do NOT paraphrase amounts.",
  ].join("\n");
}

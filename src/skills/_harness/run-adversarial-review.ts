/**
 * Typed wrapper around the adversarial-review skill.
 *
 * Runs AFTER fact-check (which guards grounding) and BEFORE humanize
 * (which polishes surface language). Asks an independent model to play
 * the rep and find weak points — weak ask, missing leverage, easy
 * deflection, etc. If any high-severity issues come back, the
 * negotiation loop feeds them as a tool_result error and the agent
 * redrafts (same retry-once mechanic as fact-check).
 *
 * Same gates and fail-open behavior as fact-check (BONSAI_CROSSMODAL=1).
 */
import { runSkill } from "./skill-runner.ts";
import type { LLMTool, ProviderRunners } from "../../llm/provider.ts";

export type WeakPointKind =
  | "weak_ask"
  | "missing_leverage"
  | "weak_deadline"
  | "easy_deflection"
  | "tone_mismatch"
  | "wrong_audience"
  | "other";

export type WeakPointSeverity = "high" | "medium" | "low";

export interface WeakPoint {
  kind: WeakPointKind;
  severity: WeakPointSeverity;
  detail: string;
}

export interface AdversarialResult {
  passed: boolean;
  weak_points: WeakPoint[];
  /** True when the check was skipped (env gate off or fail-open). */
  skipped: boolean;
}

const ALLOWED_KINDS: ReadonlySet<WeakPointKind> = new Set([
  "weak_ask",
  "missing_leverage",
  "weak_deadline",
  "easy_deflection",
  "tone_mismatch",
  "wrong_audience",
  "other",
]);

const ADVERSARIAL_TOOL: LLMTool = {
  name: "adversarial_report",
  description: "Report whether the draft has high-severity weak points a rep would exploit.",
  input_schema: {
    type: "object",
    required: ["passed", "weak_points"],
    properties: {
      passed: { type: "boolean" },
      weak_points: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "severity", "detail"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "weak_ask",
                "missing_leverage",
                "weak_deadline",
                "easy_deflection",
                "tone_mismatch",
                "wrong_audience",
                "other",
              ],
            },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            detail: { type: "string", minLength: 5, maxLength: 240 },
          },
        },
      },
    },
  },
};

export interface AdversarialReviewOpts {
  draft_subject: string;
  draft_body: string;
  bill_kind: string;
  prior_outbound: string;
  latest_inbound: string;
  floor_context: string;
  runners?: ProviderRunners;
}

export async function adversarialReview(opts: AdversarialReviewOpts): Promise<AdversarialResult> {
  if (process.env.BONSAI_CROSSMODAL !== "1") {
    return { passed: true, weak_points: [], skipped: true };
  }
  try {
    const resp = await runSkill("adversarial-review", {
      vars: {
        draft_subject: opts.draft_subject,
        draft_body: opts.draft_body,
        bill_kind: opts.bill_kind,
        prior_outbound: opts.prior_outbound,
        latest_inbound: opts.latest_inbound,
        floor_context: opts.floor_context,
      },
      user: "Critique the draft now and return your decision via the adversarial_report tool.",
      tools: [ADVERSARIAL_TOOL],
      runners: opts.runners,
    });
    if (!resp.tool_use || resp.tool_use.name !== "adversarial_report") {
      console.warn("[adversarial-review] no tool call in response — failing open");
      return { passed: true, weak_points: [], skipped: true };
    }
    const input = resp.tool_use.input as { passed?: unknown; weak_points?: unknown };
    const weakPoints = parseWeakPoints(input.weak_points);
    // Authoritative rule: a HIGH-severity weak point ALWAYS triggers a
    // retry, even if the model also returned passed=true (the bool
    // and the list can disagree, and the explicit articulated weak
    // point is the trustworthy signal). Medium/low ship — the retry
    // budget is small and humanize handles surface polish.
    const hasHigh = weakPoints.some((w) => w.severity === "high");
    return { passed: !hasHigh, weak_points: weakPoints, skipped: false };
  } catch (err) {
    console.warn(`[adversarial-review] failed (fail-open): ${(err as Error).message}`);
    return { passed: true, weak_points: [], skipped: true };
  }
}

function parseWeakPoints(raw: unknown): WeakPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: WeakPoint[] = [];
  for (const v of raw) {
    if (typeof v !== "object" || v === null) continue;
    const obj = v as { kind?: unknown; severity?: unknown; detail?: unknown };
    if (typeof obj.kind !== "string" || !ALLOWED_KINDS.has(obj.kind as WeakPointKind)) continue;
    if (obj.severity !== "high" && obj.severity !== "medium" && obj.severity !== "low") continue;
    if (typeof obj.detail !== "string" || obj.detail.length < 1) continue;
    out.push({
      kind: obj.kind as WeakPointKind,
      severity: obj.severity,
      detail: obj.detail.slice(0, 240),
    });
  }
  return out;
}

/** Format weak points as a tool_result error string fed back to the
 * draft-reply LLM so it can redraft. Only HIGH-severity ones are
 * included in the redraft instruction — those are what triggered the
 * retry. */
export function weakPointsToFeedback(weakPoints: WeakPoint[]): string {
  const high = weakPoints.filter((w) => w.severity === "high");
  if (high.length === 0) return "Adversarial review passed.";
  const lines = high.map((w, i) => `${i + 1}. [${w.kind}] ${w.detail}`);
  return [
    "Adversarial review found high-severity weak points a rep could exploit.",
    "Weak points:",
    ...lines,
    "Redraft the email and call send_email again. Address every weak point above. Use only grounded analyzer facts — do NOT invent leverage that isn't supported.",
  ].join("\n");
}

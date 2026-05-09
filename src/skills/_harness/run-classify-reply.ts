/**
 * Typed wrapper around the classify-reply skill.
 *
 * Cheap independent classifier that runs on the latest inbound rep
 * email before the negotiation agent drafts its next move. The result
 * is injected into the agent's user message as a structured prior —
 * "GPT thinks this looks like a partial_concession". The agent is not
 * bound by it, but the prior cuts down on misclassification when the
 * rep's wording is borderline.
 *
 * Same env gate as fact-check (BONSAI_CROSSMODAL=1) and same fail-open
 * behavior. When skipped, returns null and the caller injects nothing.
 */
import { runSkill } from "./skill-runner.ts";
import type { LLMTool, ProviderRunners } from "../../llm/provider.ts";

export type ReplyKind =
  | "concession"
  | "partial_concession"
  | "denial"
  | "stall"
  | "request_info"
  | "hostile"
  | "signature_demand"
  | "other";

export type ClassifyConfidence = "high" | "medium" | "low";

export interface ClassifyResult {
  kind: ReplyKind;
  confidence: ClassifyConfidence;
  /** Short anchor — the phrase the classifier saw. ≤ 200 chars. */
  reasoning: string;
}

const ALLOWED_KINDS: ReadonlySet<ReplyKind> = new Set([
  "concession",
  "partial_concession",
  "denial",
  "stall",
  "request_info",
  "hostile",
  "signature_demand",
  "other",
]);

const CLASSIFY_TOOL: LLMTool = {
  name: "classify_reply",
  description: "Report the kind, confidence, and brief reasoning for the latest inbound rep email.",
  input_schema: {
    type: "object",
    required: ["kind", "confidence", "reasoning"],
    properties: {
      kind: {
        type: "string",
        enum: [
          "concession",
          "partial_concession",
          "denial",
          "stall",
          "request_info",
          "hostile",
          "signature_demand",
          "other",
        ],
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reasoning: { type: "string", minLength: 5, maxLength: 200 },
    },
  },
};

export interface ClassifyReplyOpts {
  latest_inbound: string;
  prior_outbound: string;
  bill_kind: string;
  /** Compact "floor=$100; original ask=$1000; rep last offered=?" string.
   * The classifier needs this to distinguish concession (at/below floor)
   * from partial_concession (between). */
  floor_context: string;
  runners?: ProviderRunners;
}

export async function classifyReply(opts: ClassifyReplyOpts): Promise<ClassifyResult | null> {
  if (process.env.BONSAI_CROSSMODAL !== "1") return null;
  try {
    const resp = await runSkill("classify-reply", {
      vars: {
        latest_inbound: opts.latest_inbound,
        prior_outbound: opts.prior_outbound,
        bill_kind: opts.bill_kind,
        floor_context: opts.floor_context,
      },
      user: "Classify the latest inbound now. Return your decision via the classify_reply tool.",
      tools: [CLASSIFY_TOOL],
      runners: opts.runners,
    });
    if (!resp.tool_use || resp.tool_use.name !== "classify_reply") {
      return null;
    }
    const input = resp.tool_use.input as {
      kind?: unknown;
      confidence?: unknown;
      reasoning?: unknown;
    };
    if (typeof input.kind !== "string" || !ALLOWED_KINDS.has(input.kind as ReplyKind)) return null;
    const confidence =
      input.confidence === "high" || input.confidence === "medium" || input.confidence === "low"
        ? input.confidence
        : "low";
    const reasoning = typeof input.reasoning === "string" ? input.reasoning.slice(0, 200) : "";
    if (!reasoning) return null;
    return { kind: input.kind as ReplyKind, confidence, reasoning };
  } catch (err) {
    console.warn(`[classify-reply] failed (fail-open): ${(err as Error).message}`);
    return null;
  }
}

/** Format the classification as a one-block prior to inject into the
 * draft-reply user message. Returns empty string when result is null. */
export function classifyReplyAsPrior(result: ClassifyResult | null): string {
  if (!result) return "";
  return `\n\n## Reply classification (cross-model prior)\n\nkind=${result.kind}; confidence=${result.confidence}\nreasoning: ${result.reasoning}\n\nThis is a prior, not a directive. Use it as a hint about the rep's posture; you decide the next move from your tool set.`;
}

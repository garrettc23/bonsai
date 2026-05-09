/**
 * Typed wrapper around the propagate-to-brain skill.
 *
 * Called at thread close. Loads prior brain context for this provider,
 * asks Claude to extract pattern-level events + rebuild compiled_truth,
 * then writes the result through provider-brain's PII-gated upsert.
 *
 * Three production gates (any one off → no-op):
 *   - BONSAI_BRAIN=1               (global feature flag)
 *   - BONSAI_BRAIN_OPT_OUT !== "1" (per-user opt-out)
 *   - BONSAI_BRAIN_HMAC_KEY set    (required to hash user_id)
 *
 * Fail-open: if Claude errors, returns null and logs a warning. We
 * never block thread completion on brain propagation.
 */
import { runSkill } from "./skill-runner.ts";
import {
  isOptedOut,
  providerKey,
  readBrain,
  readRecentEvents,
  upsertBrain,
  type BrainEvent,
  type BrainPage,
} from "../../brain/provider-brain.ts";
import type { LLMTool, ProviderRunners } from "../../llm/provider.ts";

/** Tool schema kinds — must match the skill's prompt enum exactly. */
const ALLOWED_KINDS = [
  "first_offer_pattern",
  "objection_pattern",
  "concession_unlock",
  "escalation_pattern",
  "signature_demand",
  "outcome_pattern",
] as const;
type AllowedKind = (typeof ALLOWED_KINDS)[number];

const PROPAGATE_TOOL: LLMTool = {
  name: "propagate_brain",
  description:
    "Emit the rebuilt compiled_truth playbook and the pattern-level events extracted from the just-closed thread.",
  input_schema: {
    type: "object",
    required: ["compiled_truth", "events"],
    properties: {
      compiled_truth: {
        type: "string",
        minLength: 30,
        maxLength: 800,
      },
      events: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          required: ["kind", "detail"],
          properties: {
            kind: { type: "string", enum: [...ALLOWED_KINDS] },
            detail: { type: "string", minLength: 5, maxLength: 200 },
          },
        },
      },
    },
  },
};

export interface PropagateOpts {
  provider_display_name: string;
  bill_kind: string;
  thread_summary: string;
  final_outcome: string;
  thread_id: string;
  user_id: string;
  runners?: ProviderRunners;
}

export async function propagateToBrain(opts: PropagateOpts): Promise<BrainPage | null> {
  if (process.env.BONSAI_BRAIN !== "1") return null;
  if (isOptedOut()) return null;
  if (!process.env.BONSAI_BRAIN_HMAC_KEY?.trim()) {
    console.warn("[brain] BONSAI_BRAIN=1 but BONSAI_BRAIN_HMAC_KEY is unset; skipping propagation");
    return null;
  }
  const key = providerKey(opts.provider_display_name);
  const prior = readBrain(key);
  const priorEvents = readRecentEvents(key, 50);

  try {
    const resp = await runSkill("propagate-to-brain", {
      vars: {
        provider_display_name: opts.provider_display_name,
        bill_kind: opts.bill_kind,
        prior_compiled_truth: prior?.compiled_truth ?? "(no prior playbook — this is the first thread)",
        prior_events: formatPriorEvents(priorEvents),
        thread_summary: opts.thread_summary,
        final_outcome: opts.final_outcome,
      },
      user: "Run the propagation now and return the rebuilt playbook + events via the propagate_brain tool.",
      tools: [PROPAGATE_TOOL],
      runners: opts.runners,
    });
    if (!resp.tool_use || resp.tool_use.name !== "propagate_brain") {
      console.warn("[brain] propagate skill returned no tool call; skipping write");
      return null;
    }
    const input = resp.tool_use.input as { compiled_truth?: unknown; events?: unknown };
    const compiledTruth = typeof input.compiled_truth === "string" ? input.compiled_truth : "";
    const events = parseEvents(input.events);
    if (!compiledTruth || events.length === 0) {
      console.warn("[brain] propagate output missing compiled_truth or events; skipping");
      return null;
    }
    return upsertBrain({
      provider_key: key,
      display_name: opts.provider_display_name,
      bill_kind: opts.bill_kind,
      compiled_truth: compiledTruth,
      events,
      thread_id: opts.thread_id,
      user_id: opts.user_id,
    });
  } catch (err) {
    console.warn(`[brain] propagate failed (fail-open): ${(err as Error).message}`);
    return null;
  }
}

function formatPriorEvents(events: BrainEvent[]): string {
  if (events.length === 0) return "(no prior events)";
  return events.slice(0, 50).map((e, i) => `${i + 1}. [${e.kind}] ${e.detail}`).join("\n");
}

function parseEvents(raw: unknown): BrainEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: BrainEvent[] = [];
  for (const v of raw) {
    if (typeof v !== "object" || v === null) continue;
    const obj = v as { kind?: unknown; detail?: unknown };
    if (typeof obj.kind !== "string" || typeof obj.detail !== "string") continue;
    if (!ALLOWED_KINDS.includes(obj.kind as AllowedKind)) continue;
    if (obj.detail.length < 1 || obj.detail.length > 200) continue;
    out.push({ kind: obj.kind, detail: obj.detail });
  }
  return out;
}

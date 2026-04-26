/**
 * ElevenLabs voice server-tool webhook handlers.
 *
 * ElevenLabs Conversational AI invokes server tools mid-call by POSTing to
 * the URLs we baked into the agent config (`src/voice/agent-config.ts`).
 * Authentication is a constant-time Bearer compare against
 * `ELEVENLABS_WEBHOOK_SECRET` — that's the same secret embedded in the
 * agent's `request_headers` at agent-creation time, so the request must
 * come from our agent.
 *
 * Each handler:
 *   1. Verifies Bearer.
 *   2. Parses `{ conversation_id, tool_call_id?, parameters }`.
 *   3. Looks up which user owns that conversation via the persisted
 *      meta file under `out/users/<id>/calls/<conversation_id>.json`.
 *   4. Sets up the user context, takes the per-conversation lock,
 *      dispatches into `tool-handlers.dispatchToolCall` (the same
 *      handler the simulator uses), appends a transcript turn, and
 *      writes the meta file back.
 *   5. Returns the `result` payload as JSON to ElevenLabs so the agent
 *      can speak it.
 *
 * `end_call` additionally finalizes the meta (status="ended", ended_at)
 * and increments the operator's daily voice spend with the actual
 * computed cost for the call duration.
 */
import { timingSafeEqual } from "node:crypto";
import { getUserById } from "../lib/auth.ts";
import {
  appendTranscriptTurn,
  findConversationOwner,
  loadConversationMeta,
  saveConversationMeta,
  withCallLock,
  type ConversationMeta,
} from "../lib/call-store.ts";
import { withUserContext } from "../lib/user-context.ts";
import { addSpend } from "../lib/voice-spend.ts";
import { estimateCallCost } from "../lib/voice-cost-estimate.ts";
import {
  dispatchToolCall,
  loadCallState,
  saveCallState,
  type CallState,
} from "../voice/tool-handlers.ts";

export const VOICE_TOOL_NAMES = [
  "get_disputed_line",
  "confirm_eob_amount",
  "propose_general_discount",
  "record_negotiated_amount",
  "request_human_handoff",
  "end_call",
] as const;

export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

export function stateCallIdFor(conversation_id: string): string {
  return `${conversation_id}_state`;
}

/**
 * Constant-time Bearer-token compare. The secret arrives in the
 * Authorization header as `Bearer <token>`; `process.env.ELEVENLABS_WEBHOOK_SECRET`
 * is the source of truth.
 *
 * In production, refuse the request if the secret is unset (fail-closed). In
 * development we allow unset to make local testing painless — the agent
 * config still embeds whatever `webhook_secret` the dial endpoint passed,
 * so a dev who points the agent at their tunnel sees the same flow.
 */
export function verifyBearer(req: Request, secret: string | undefined): boolean {
  if (!secret || !secret.length) {
    return process.env.NODE_ENV !== "production";
  }
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface WebhookBody {
  conversation_id?: string;
  tool_call_id?: string;
  parameters?: unknown;
}

// Allowlist for conversation_id. ElevenLabs uses opaque hex/uuid-shaped IDs;
// a strict ASCII allowlist keeps a malicious or compromised caller from
// path-traversing into another tenant's calls dir via filesystem joins
// downstream (call-store.ts builds paths from this value).
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

interface DispatchOk {
  status: 200;
  body: { result: unknown } | { error: string };
}
interface DispatchFail {
  status: 401 | 404 | 400 | 500;
  body: { error: string };
}
type DispatchOutcome = DispatchOk | DispatchFail;

async function runVoiceWebhook(
  toolName: VoiceToolName,
  req: Request,
): Promise<DispatchOutcome> {
  if (!verifyBearer(req, process.env.ELEVENLABS_WEBHOOK_SECRET)) {
    return { status: 401, body: { error: "invalid bearer" } };
  }

  let body: WebhookBody;
  try {
    body = (await req.json()) as WebhookBody;
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }
  const conversation_id = body.conversation_id;
  if (!conversation_id || typeof conversation_id !== "string") {
    return { status: 400, body: { error: "missing conversation_id" } };
  }
  if (!CONVERSATION_ID_PATTERN.test(conversation_id)) {
    return { status: 400, body: { error: "invalid conversation_id" } };
  }

  const owner = findConversationOwner(conversation_id);
  if (!owner) {
    return { status: 404, body: { error: "unknown conversation_id" } };
  }
  const user = getUserById(owner.user_id);
  if (!user) {
    return { status: 404, body: { error: "owner not found" } };
  }

  const params = (body.parameters ?? {}) as Record<string, unknown>;

  const out = await withUserContext(user, async () =>
    withCallLock(conversation_id, async () => {
      const stateId = stateCallIdFor(conversation_id);
      const state = loadCallState(stateId);
      if (!state) {
        return { status: 404 as const, body: { error: "state not found" } };
      }

      const dispatched = dispatchToolCall(state, toolName, params);

      // Refresh meta from disk in case a sibling webhook updated it inside
      // a prior critical section. Saved under the same lock, so this read
      // is consistent.
      const meta = loadConversationMeta(owner.user_id, conversation_id);
      if (!meta) {
        return { status: 404 as const, body: { error: "meta not found" } };
      }
      // Late-arriving tool calls after end_call must not mutate the
      // finalized envelope — refuse with 409 so ElevenLabs gets a clear
      // signal that the call is over.
      if (meta.status !== "active") {
        return {
          status: 200 as const,
          body: { result: { ignored: true, reason: `call status: ${meta.status}` } },
        };
      }

      appendTranscriptTurn(meta, {
        role: "tool",
        text: toolName,
        ts: Date.now(),
        tool_use: { name: toolName, args: params },
        tool_result: { name: toolName, result: dispatched },
      });

      // Mirror committed outcome from CallState to the meta envelope so
      // the SPA (which reads only the meta file) sees the negotiated total.
      if (state.outcome.negotiated_amount != null) {
        meta.outcome.negotiated_amount = state.outcome.negotiated_amount;
      }
      if (state.outcome.commitment_notes && !meta.outcome.notes) {
        meta.outcome.notes = state.outcome.commitment_notes;
      }

      if (toolName === "end_call") {
        finalizeCall(meta, state);
      }

      saveConversationMeta(meta);
      saveCallState(state); // dispatchToolCall already saved, but rewrite is idempotent
      return { status: 200 as const, body: dispatched };
    }),
  );
  return out;
}

function finalizeCall(meta: ConversationMeta, state: CallState): void {
  if (meta.status === "ended") return;
  const startedAt = meta.started_at;
  const endedAt = Date.now();
  meta.status = "ended";
  meta.ended_at = endedAt;
  // Treat dryrun as zero-cost — the dial endpoint set source="real" only when
  // a real outbound call was placed.
  if (meta.source === "real") {
    const minutes = Math.max(0, (endedAt - startedAt) / 60000);
    const cost = estimateCallCost(minutes).max_usd;
    addSpend(cost);
  }
  // Lift the final negotiated amount one more time in case the last tool
  // event was record_negotiated_amount inside this same finalize call.
  if (state.outcome.negotiated_amount != null) {
    meta.outcome.negotiated_amount = state.outcome.negotiated_amount;
  }
  if (state.outcome.commitment_notes && !meta.outcome.notes) {
    meta.outcome.notes = state.outcome.commitment_notes;
  }
}

function toResponse(out: DispatchOutcome): Response {
  return Response.json(out.body, { status: out.status });
}

export async function handleVoiceWebhook(
  toolName: VoiceToolName,
  req: Request,
): Promise<Response> {
  try {
    return toResponse(await runVoiceWebhook(toolName, req));
  } catch (err) {
    console.error(`voice webhook ${toolName} error:`, err);
    return Response.json(
      { error: (err as Error).message ?? "voice webhook error" },
      { status: 500 },
    );
  }
}

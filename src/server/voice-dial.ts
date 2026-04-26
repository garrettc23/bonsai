/**
 * Real ElevenLabs voice dial helper. Used by:
 *   - POST /api/voice/dial         (SPA-initiated, after the pre-call modal)
 *   - src/orchestrator.ts          (when ElevenLabs env is configured)
 *
 * Steps:
 *   1. Per-user daily call limit (sliding-window rate limit).
 *   2. Operator daily voice budget cap (today_spend + max_estimate < cap).
 *   3. getOrCreateAgent — caches per-user ElevenLabs agent_id keyed on
 *      a SHA-256 of the generated config so identical bills reuse the
 *      same agent across calls.
 *   4. VOICE_DRY_RUN short-circuit — returns a synthetic conversation_id
 *      and persists a meta envelope with status="active", but does not
 *      invoke startOutboundCall. The end_call webhook still finalizes the
 *      meta when fired by hand (curl) for round-trip testing.
 *   5. ElevenLabsClient.startOutboundCall — places the actual call.
 *   6. Persist a CallState (`<conversation_id>_state.json`) so the
 *      tool-handler webhooks have somewhere to read/mutate, and a
 *      ConversationMeta (`<conversation_id>.json`) with status="active"
 *      so the SPA can render a live transcript view.
 */
import { ElevenLabsClient } from "../voice/client.ts";
import {
  newCallState,
  saveCallState,
  type CallState,
} from "../voice/tool-handlers.ts";
import {
  saveConversationMeta,
  type ConversationMeta,
} from "../lib/call-store.ts";
import {
  estimateCallCost,
  DEFAULT_MAX_MINUTES,
} from "../lib/voice-cost-estimate.ts";
import { addSpend, getDailyBudgetUsd, getTodaySpendUsd } from "../lib/voice-spend.ts";
import { getOrCreateAgent } from "../lib/voice-agent-cache.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import type { User } from "../lib/auth.ts";
import type { AnalyzerResult, BillKind } from "../types.ts";
import { stateCallIdFor } from "./voice-webhooks.ts";

export const VOICE_DAILY_LIMIT_DEFAULT = 5;

export function getVoiceDailyLimit(): number {
  const raw = process.env.BONSAI_VOICE_DAILY_LIMIT;
  if (!raw) return VOICE_DAILY_LIMIT_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : VOICE_DAILY_LIMIT_DEFAULT;
}

export interface DialVoiceOpts {
  run_id: string;
  analyzer: AnalyzerResult;
  provider_phone: string;
  bill_kind?: BillKind;
  account_holder_name?: string | null;
  final_acceptable_floor?: number;
  /** Bypass the per-user rate limit. Used by tests; not exposed to HTTP. */
  skip_rate_limit?: boolean;
  /**
   * Override the ElevenLabs client used for `createAgent`. Tests inject a
   * stub so the agent cache can be exercised without network. The actual
   * `startOutboundCall` is gated behind `VOICE_DRY_RUN` and not affected.
   */
  agent_client?: { createAgent: ElevenLabsClient["createAgent"] };
}

export type DialVoiceResult =
  | {
      ok: true;
      conversation_id: string;
      dry_run: boolean;
      agent_id: string;
      agent_cached: boolean;
    }
  | {
      ok: false;
      status: 429 | 400 | 500;
      error: string;
      retry_after_sec?: number;
    };

function webhookBaseUrl(): string | null {
  const raw = process.env.ELEVENLABS_WEBHOOK_BASE?.trim();
  if (!raw) return null;
  // The agent-config builder appends /<tool> directly to the passed base.
  // Real callbacks land at `<base>/webhooks/voice/<tool>`.
  return `${raw.replace(/\/$/, "")}/webhooks/voice`;
}

function webhookSecret(): string {
  return process.env.ELEVENLABS_WEBHOOK_SECRET?.trim() ?? "";
}

function isDryRun(): boolean {
  return process.env.VOICE_DRY_RUN === "true";
}

function buildConversationMeta(opts: {
  conversation_id: string;
  user_id: string;
  run_id: string;
  source: "real";
}): ConversationMeta {
  return {
    conversation_id: opts.conversation_id,
    run_id: opts.run_id,
    user_id: opts.user_id,
    started_at: Date.now(),
    status: "active",
    source: opts.source,
    outcome: {},
    transcript: [],
  };
}

function buildCallState(
  conversation_id: string,
  analyzer: AnalyzerResult,
  final_acceptable_floor?: number,
): CallState {
  return newCallState({
    call_id: stateCallIdFor(conversation_id),
    analyzer,
    final_acceptable_floor,
  });
}

export async function dialVoiceForUser(
  user: User,
  opts: DialVoiceOpts,
): Promise<DialVoiceResult> {
  if (!opts.skip_rate_limit) {
    const limit = getVoiceDailyLimit();
    const rl = rateLimit({
      key: `voice:user:${user.id}`,
      max: limit,
      windowMs: 24 * 60 * 60 * 1000,
    });
    if (!rl.ok) {
      return {
        ok: false,
        status: 429,
        error: "Daily voice call limit hit.",
        retry_after_sec: rl.retryAfterSec,
      };
    }
  }

  const cap = getDailyBudgetUsd();
  const today = getTodaySpendUsd();
  const maxEstimate = estimateCallCost(DEFAULT_MAX_MINUTES).max_usd;
  if (today + maxEstimate > cap) {
    return {
      ok: false,
      status: 429,
      error: "Voice budget reached for today; try email negotiation.",
    };
  }

  if (!opts.provider_phone) {
    return { ok: false, status: 400, error: "missing provider_phone" };
  }

  const base = webhookBaseUrl();
  if (!base) {
    return {
      ok: false,
      status: 500,
      error: "ELEVENLABS_WEBHOOK_BASE not configured",
    };
  }

  const cached = await getOrCreateAgent(user, {
    result: opts.analyzer,
    webhook_base_url: base,
    webhook_secret: webhookSecret(),
    bill_kind: opts.bill_kind,
    account_holder_name: opts.account_holder_name ?? null,
    final_acceptable_floor: opts.final_acceptable_floor,
    client: opts.agent_client,
  });

  if (isDryRun()) {
    const conversation_id = `dryrun_${cryptoRandom()}`;
    const state = buildCallState(conversation_id, opts.analyzer, opts.final_acceptable_floor);
    saveCallState(state);
    saveConversationMeta(
      buildConversationMeta({
        conversation_id,
        user_id: user.id,
        run_id: opts.run_id,
        source: "real",
      }),
    );
    console.log(
      `[voice-dry-run] would dial ${opts.provider_phone} via agent ${cached.agent_id}; conversation_id=${conversation_id}`,
    );
    return {
      ok: true,
      conversation_id,
      dry_run: true,
      agent_id: cached.agent_id,
      agent_cached: cached.cached,
    };
  }

  const phoneNumberId = process.env.ELEVENLABS_TWILIO_PHONE_NUMBER_ID?.trim();
  if (!phoneNumberId) {
    return {
      ok: false,
      status: 500,
      error: "ELEVENLABS_TWILIO_PHONE_NUMBER_ID not configured",
    };
  }

  const client = new ElevenLabsClient();
  const call = await client.startOutboundCall({
    agent_id: cached.agent_id,
    phone_number_id: phoneNumberId,
    to_number: opts.provider_phone,
  });

  const state = buildCallState(call.conversation_id, opts.analyzer, opts.final_acceptable_floor);
  saveCallState(state);
  saveConversationMeta(
    buildConversationMeta({
      conversation_id: call.conversation_id,
      user_id: user.id,
      run_id: opts.run_id,
      source: "real",
    }),
  );

  return {
    ok: true,
    conversation_id: call.conversation_id,
    dry_run: false,
    agent_id: cached.agent_id,
    agent_cached: cached.cached,
  };
}

function cryptoRandom(): string {
  // Bun ships globalThis.crypto.randomUUID; trim hyphens for compactness.
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Operator-side helper to record the actual cost when a call ends.
 * The end_call webhook calls into voice-spend.addSpend directly; this
 * re-export is kept here so callers don't have to import voice-spend.
 */
export { addSpend };

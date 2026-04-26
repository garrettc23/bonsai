/**
 * Per-conversation lock + transcript persistence for real ElevenLabs calls.
 *
 * The 6 voice webhooks (`/webhooks/voice/*`) all do read-modify-write on the
 * same per-conversation transcript file. Without serialization, two
 * webhooks landing back-to-back can clobber each other. This mirrors the
 * `withThreadLock` pattern from `src/lib/thread-store.ts`, keyed on
 * `conversation_id` instead of `thread_id`.
 *
 * Transcript file layout:
 *   out/users/<id>/calls/<conversation_id>.json
 *
 * (Note: `src/voice/tool-handlers.ts` writes its own CallState to
 * `<call_id>.json`. For real calls we set `call_id === conversation_id` so
 * a single file holds both shapes — the webhook handler writes a
 * `ConversationMeta` envelope alongside the existing `tool_events` log.)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot, userPaths } from "./user-paths.ts";

const callLocks = new Map<string, Promise<unknown>>();

export async function withCallLock<T>(
  conversation_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = callLocks.get(conversation_id) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prev.then(() => next);
  callLocks.set(conversation_id, chain);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (callLocks.get(conversation_id) === chain) {
      callLocks.delete(conversation_id);
    }
  }
}

export type ConversationStatus = "active" | "ended" | "failed";
export type ConversationSource = "real" | "simulator";

export interface TranscriptTurn {
  role: "agent" | "rep" | "tool";
  text: string;
  ts: number;
  tool_use?: { name: string; args: unknown };
  tool_result?: { name: string; result: unknown };
}

export interface ConversationMeta {
  conversation_id: string;
  run_id: string;
  user_id: string;
  started_at: number;
  ended_at?: number;
  status: ConversationStatus;
  source: ConversationSource;
  outcome: { negotiated_amount?: number; notes?: string };
  transcript: TranscriptTurn[];
}

function metaPath(user_id: string, conversation_id: string): string {
  return join(userPaths(user_id).callsDir, `${conversation_id}.json`);
}

export function saveConversationMeta(meta: ConversationMeta): void {
  const dir = userPaths(meta.user_id).callsDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(meta.user_id, meta.conversation_id), JSON.stringify(meta, null, 2), "utf8");
}

export function loadConversationMeta(
  user_id: string,
  conversation_id: string,
): ConversationMeta | null {
  const p = metaPath(user_id, conversation_id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ConversationMeta;
}

/**
 * Resolve the user_id for a given conversation_id by scanning each user's
 * callsDir for a matching file. Used by the unauthenticated webhook handlers
 * to find the right tenant after Bearer-verifying the request.
 *
 * Cheap because each user has at most a few call files; only walked on
 * webhook arrival, not on hot paths.
 */
export function findConversationOwner(conversation_id: string): {
  user_id: string;
  meta: ConversationMeta;
} | null {
  const usersDir = join(dataRoot(), "users");
  if (!existsSync(usersDir)) return null;
  for (const userId of readdirSync(usersDir)) {
    const callsDir = join(usersDir, userId, "calls");
    if (!existsSync(callsDir)) continue;
    const filePath = join(callsDir, `${conversation_id}.json`);
    if (existsSync(filePath)) {
      try {
        const meta = JSON.parse(readFileSync(filePath, "utf8")) as ConversationMeta;
        if (meta.conversation_id === conversation_id) {
          return { user_id: userId, meta };
        }
      } catch {
        // Skip unreadable files — another tenant's malformed JSON shouldn't
        // block routing.
      }
    }
  }
  return null;
}

export function appendTranscriptTurn(
  meta: ConversationMeta,
  turn: TranscriptTurn,
): ConversationMeta {
  meta.transcript.push(turn);
  saveConversationMeta(meta);
  return meta;
}

/** Test hook — reset the in-process lock map between tests. */
export function _resetCallLocksForTest(): void {
  callLocks.clear();
}

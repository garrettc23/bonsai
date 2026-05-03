/**
 * Thread store helpers — concurrency safety + idempotent inbound writes.
 *
 * Two flows write to out/threads/{thread_id}.json concurrently during a live
 * demo: the agent sending an outbound email, and the Resend webhook appending
 * an inbound reply. Both do read-modify-write on the same JSON file. Without
 * serialization, last-writer-wins drops messages.
 *
 * `withThreadLock` serializes work per thread_id via an in-process Promise
 * chain. It is process-local (Bun is single-process for `bun run serve`),
 * which is the right scope: the webhook handler and the agent both run in
 * this process.
 *
 * `appendInboundIdempotent` deduplicates by message_id so Resend's at-least-
 * once webhook delivery doesn't double-process the same email.
 */
import {
  type ThreadState,
  loadThread,
  saveThread,
} from "../clients/email-mock.ts";
import type { InboundEmail } from "../clients/email.ts";

const locks = new Map<string, Promise<unknown>>();

export async function withThreadLock<T>(
  thread_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(thread_id) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Two correctness fixes:
  //  1. Stash the chained promise in a variable so the cleanup compare-by-
  //     reference actually matches (calling prev.then() twice produces
  //     two different promise objects, so the equality check never
  //     fired and the map grew unboundedly per thread).
  //  2. Catch on prev so a rejection from a prior holder does NOT
  //     short-circuit the chain — without the catch, `await prev`
  //     throws synchronously and the next caller proceeds without
  //     awaiting `next`, which lets two writers run concurrently.
  const chained = prev.catch(() => undefined).then(() => next);
  locks.set(thread_id, chained);
  try {
    await prev.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (locks.get(thread_id) === chained) {
      locks.delete(thread_id);
    }
  }
}

export interface AppendResult {
  thread: ThreadState;
  inserted: boolean;
}

export async function appendInboundIdempotent(
  thread_id: string,
  inbound: InboundEmail,
  dir?: string,
): Promise<AppendResult> {
  return withThreadLock(thread_id, async () => {
    const thread = loadThread(thread_id, dir);
    if (thread.inbound.some((m) => m.message_id === inbound.message_id)) {
      return { thread, inserted: false };
    }
    thread.inbound.push(inbound);
    saveThread(thread, dir);
    return { thread, inserted: true };
  });
}

/**
 * MockEmailClient — writes outbound to a JSON mailbox on disk and reads
 * inbound from the same file. The simulator (see src/simulate-reply.ts) writes
 * replies into this mailbox between negotiator turns.
 *
 * The on-disk format is a single JSON file per thread:
 * out/users/<user_id>/threads/{thread_id}.json with shape
 * { outbound: SentEmail[], inbound: InboundEmail[] }. The default dir is
 * the active user's threads directory (see user-paths.ts); tests can
 * override by passing `dir` explicitly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EmailClient,
  InboundEmail,
  OutboundEmail,
  SentEmail,
} from "./email.ts";
import { newId } from "./email.ts";
import { currentUserPaths } from "../lib/user-paths.ts";

function defaultThreadsDir(): string {
  return currentUserPaths().threadsDir;
}

export interface ThreadState {
  thread_id: string;
  outbound: SentEmail[];
  inbound: InboundEmail[];
}

export function threadPath(thread_id: string, dir?: string): string {
  return join(dir ?? defaultThreadsDir(), `${thread_id}.json`);
}

export function loadThread(thread_id: string, dir?: string): ThreadState {
  const path = threadPath(thread_id, dir);
  if (!existsSync(path)) {
    return { thread_id, outbound: [], inbound: [] };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveThread(thread: ThreadState, dir?: string): void {
  const d = dir ?? defaultThreadsDir();
  mkdirSync(d, { recursive: true });
  writeFileSync(threadPath(thread.thread_id, d), JSON.stringify(thread, null, 2), "utf8");
}

export class MockEmailClient implements EmailClient {
  private threadsDir: string;
  constructor(threadsDir?: string) {
    this.threadsDir = threadsDir ?? defaultThreadsDir();
  }

  async send(msg: OutboundEmail): Promise<SentEmail> {
    const sent: SentEmail = {
      message_id: newId("msg"),
      sent_at: new Date().toISOString(),
      to: msg.to,
      from: msg.from,
      subject: msg.subject,
      body_markdown: msg.body_markdown,
      thread_id: msg.thread_id,
      in_reply_to: msg.in_reply_to,
      cc: msg.cc,
    };
    const thread = loadThread(msg.thread_id, this.threadsDir);
    thread.outbound.push(sent);
    saveThread(thread, this.threadsDir);
    return sent;
  }

  async fetchInbound(thread_id: string, since: string): Promise<InboundEmail[]> {
    const thread = loadThread(thread_id, this.threadsDir);
    const sinceMs = since ? Date.parse(since) : 0;
    return thread.inbound.filter((m) => Date.parse(m.received_at) > sinceMs);
  }

  /** For testing: manually drop an inbound message into a thread. */
  async ingestInbound(msg: Omit<InboundEmail, "message_id" | "received_at">): Promise<InboundEmail> {
    const inbound: InboundEmail = {
      ...msg,
      message_id: newId("in"),
      received_at: new Date().toISOString(),
    };
    const thread = loadThread(msg.thread_id, this.threadsDir);
    thread.inbound.push(inbound);
    saveThread(thread, this.threadsDir);
    return inbound;
  }
}

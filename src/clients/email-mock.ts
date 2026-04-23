/**
 * MockEmailClient — writes outbound to a JSON mailbox on disk and reads
 * inbound from the same file. The simulator (see src/simulate-reply.ts) writes
 * replies into this mailbox between negotiator turns.
 *
 * The on-disk format is a single JSON file per thread: out/threads/{thread_id}.json
 * with shape { outbound: SentEmail[], inbound: InboundEmail[] }. This makes
 * it easy to inspect a thread at any time with `cat out/threads/*.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EmailClient,
  InboundEmail,
  OutboundEmail,
  SentEmail,
} from "./email.ts";
import { newId } from "./email.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_THREADS_DIR = join(__dirname, "..", "..", "out", "threads");

export interface ThreadState {
  thread_id: string;
  outbound: SentEmail[];
  inbound: InboundEmail[];
}

export function threadPath(thread_id: string, dir: string = DEFAULT_THREADS_DIR): string {
  return join(dir, `${thread_id}.json`);
}

export function loadThread(thread_id: string, dir: string = DEFAULT_THREADS_DIR): ThreadState {
  const path = threadPath(thread_id, dir);
  if (!existsSync(path)) {
    return { thread_id, outbound: [], inbound: [] };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveThread(thread: ThreadState, dir: string = DEFAULT_THREADS_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(threadPath(thread.thread_id, dir), JSON.stringify(thread, null, 2), "utf8");
}

export class MockEmailClient implements EmailClient {
  constructor(private threadsDir: string = DEFAULT_THREADS_DIR) {}

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

/**
 * MockSmsClient — on-disk SMS thread store, mirror of email-mock.ts.
 *
 * Writes every outbound to out/sms-threads/{thread_id}.json with shape
 * { outbound: SentSms[], inbound: InboundSms[] }. The simulator (see
 * src/simulate-sms-reply.ts) appends inbound between negotiator turns.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SmsClient,
  OutboundSms,
  SentSms,
  InboundSms,
} from "./sms.ts";
import { newSmsId, segmentCount } from "./sms.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_THREADS_DIR = join(__dirname, "..", "..", "out", "sms-threads");

export interface SmsThreadState {
  thread_id: string;
  outbound: SentSms[];
  inbound: InboundSms[];
}

export function smsThreadPath(thread_id: string, dir: string = DEFAULT_THREADS_DIR): string {
  return join(dir, `${thread_id}.json`);
}

export function loadSmsThread(thread_id: string, dir: string = DEFAULT_THREADS_DIR): SmsThreadState {
  const path = smsThreadPath(thread_id, dir);
  if (!existsSync(path)) return { thread_id, outbound: [], inbound: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveSmsThread(thread: SmsThreadState, dir: string = DEFAULT_THREADS_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(smsThreadPath(thread.thread_id, dir), JSON.stringify(thread, null, 2), "utf8");
}

export class MockSmsClient implements SmsClient {
  constructor(private threadsDir: string = DEFAULT_THREADS_DIR) {}

  async send(msg: OutboundSms): Promise<SentSms> {
    const sent: SentSms = {
      message_id: newSmsId("sms"),
      sent_at: new Date().toISOString(),
      to: msg.to,
      from: msg.from,
      body: msg.body,
      thread_id: msg.thread_id,
      in_reply_to: msg.in_reply_to,
      segments: segmentCount(msg.body),
    };
    const thread = loadSmsThread(msg.thread_id, this.threadsDir);
    thread.outbound.push(sent);
    saveSmsThread(thread, this.threadsDir);
    return sent;
  }

  async fetchInbound(thread_id: string, since: string): Promise<InboundSms[]> {
    const thread = loadSmsThread(thread_id, this.threadsDir);
    const sinceMs = since ? Date.parse(since) : 0;
    return thread.inbound.filter((m) => Date.parse(m.received_at) > sinceMs);
  }

  /** For testing / simulator: manually append an inbound SMS. */
  async ingestInbound(msg: Omit<InboundSms, "message_id" | "received_at">): Promise<InboundSms> {
    const inbound: InboundSms = {
      ...msg,
      message_id: newSmsId("sms-in"),
      received_at: new Date().toISOString(),
    };
    const thread = loadSmsThread(msg.thread_id, this.threadsDir);
    thread.inbound.push(inbound);
    saveSmsThread(thread, this.threadsDir);
    return inbound;
  }
}

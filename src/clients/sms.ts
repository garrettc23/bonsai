/**
 * SMS client abstraction.
 *
 * Two impls mirror the email ones:
 *   - TwilioSmsClient: real SMS via Twilio REST API. Requires TWILIO_ACCOUNT_SID
 *     + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER. Inbound routed via webhook.
 *   - MockSmsClient: JSON mailbox on disk. The simulator writes inbound replies
 *     so the negotiator sees the same shape regardless of transport.
 *
 * SMS is shorter-form than email. Each outbound message caps around 640 chars
 * (4 segments). The negotiator system prompt enforces this at draft time — the
 * client just transports the bytes.
 */

export interface OutboundSms {
  to: string;
  from: string;
  /** Plain text. Markdown not supported by SMS transports. */
  body: string;
  /** Thread correlation — matches all messages in the same dispute. */
  thread_id: string;
  /** Set when this is a reply so the simulator / webhook can correlate. */
  in_reply_to?: string;
}

export interface SentSms {
  message_id: string;
  sent_at: string;
  to: string;
  from: string;
  body: string;
  thread_id: string;
  in_reply_to?: string;
  /** How many 160-char segments Twilio would bill. Informational. */
  segments: number;
}

export interface InboundSms {
  message_id: string;
  received_at: string;
  from: string;
  to: string;
  body: string;
  thread_id: string;
  in_reply_to?: string;
}

export interface SmsClient {
  /** Send an SMS. Throws on transport failure. */
  send(msg: OutboundSms): Promise<SentSms>;
  /** Poll inbound messages for a thread after a given timestamp. */
  fetchInbound(thread_id: string, since: string): Promise<InboundSms[]>;
}

/** Rough segment count. SMS is 160 chars GSM-7, 70 chars UCS-2. We assume GSM-7. */
export function segmentCount(body: string): number {
  if (body.length === 0) return 0;
  // Concatenated SMS reserves 7 chars per segment for UDH when > 1 segment.
  if (body.length <= 160) return 1;
  return Math.ceil(body.length / 153);
}

/** Random id generator mirroring email.ts so thread/message ids look the same. */
export function newSmsId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

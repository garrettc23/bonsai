/**
 * TwilioSmsClient — real SMS delivery via Twilio Programmable Messaging.
 *
 * Env vars required:
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_FROM_NUMBER  (E.164 format, e.g. +14155551234)
 *
 * Inbound routing: Twilio POSTs to your Messaging webhook. The server's
 * /api/sms/inbound handler should translate that into a MockSmsClient.ingestInbound
 * so the negotiator sees the same InboundSms shape it'd see in simulation.
 *
 * This class is never instantiated unless the env vars are present — the
 * orchestrator falls back to MockSmsClient otherwise.
 */
import type {
  SmsClient,
  OutboundSms,
  SentSms,
  InboundSms,
} from "./sms.ts";
import { segmentCount } from "./sms.ts";

export class TwilioSmsClient implements SmsClient {
  private readonly sid: string;
  private readonly token: string;
  private readonly from: string;

  constructor(sid?: string, token?: string, from?: string) {
    this.sid = sid ?? process.env.TWILIO_ACCOUNT_SID ?? "";
    this.token = token ?? process.env.TWILIO_AUTH_TOKEN ?? "";
    this.from = from ?? process.env.TWILIO_FROM_NUMBER ?? "";
    if (!this.sid || !this.token || !this.from) {
      throw new Error(
        "TwilioSmsClient requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.",
      );
    }
  }

  async send(msg: OutboundSms): Promise<SentSms> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`;
    const body = new URLSearchParams({
      To: msg.to,
      From: msg.from || this.from,
      Body: msg.body,
    });
    const auth = Buffer.from(`${this.sid}:${this.token}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twilio send failed (${res.status}): ${text}`);
    }
    const payload = (await res.json()) as { sid: string; date_created: string };
    return {
      message_id: payload.sid,
      sent_at: payload.date_created ?? new Date().toISOString(),
      to: msg.to,
      from: msg.from || this.from,
      body: msg.body,
      thread_id: msg.thread_id,
      in_reply_to: msg.in_reply_to,
      segments: segmentCount(msg.body),
    };
  }

  async fetchInbound(_thread_id: string, _since: string): Promise<InboundSms[]> {
    // In the real deployment, inbound arrives via webhook and is persisted by
    // the server into the MockSmsClient mailbox. This method is unused in that
    // flow, so it returns [] — callers that care about inbound poll the mock
    // mailbox directly.
    return [];
  }
}

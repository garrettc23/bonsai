/**
 * ResendEmailClient — real email via Resend HTTP API.
 *
 * Send: POST https://api.resend.com/emails
 * Inbound: Resend's inbound webhook posts parsed emails to a URL we host.
 *   For now we mirror inbound into the same MockEmailClient-style thread
 *   file so the negotiator reads from one source. Webhook handler lives in
 *   src/server/webhooks.ts.
 *
 * If RESEND_API_KEY or RESEND_FROM_EMAIL is missing, construction throws.
 * The orchestrator checks env first and falls back to MockEmailClient.
 */
import { loadThread, saveThread } from "./email-mock.ts";
import type {
  EmailClient,
  InboundEmail,
  OutboundEmail,
  SentEmail,
} from "./email.ts";
import { newId } from "./email.ts";

export class ResendEmailClient implements EmailClient {
  private apiKey: string;
  private fromEmail: string;

  constructor(opts?: { apiKey?: string; fromEmail?: string }) {
    const apiKey = opts?.apiKey ?? process.env.RESEND_API_KEY;
    const fromEmail = opts?.fromEmail ?? process.env.RESEND_FROM_EMAIL;
    if (!apiKey) throw new Error("ResendEmailClient: RESEND_API_KEY not set");
    if (!fromEmail) throw new Error("ResendEmailClient: RESEND_FROM_EMAIL not set");
    this.apiKey = apiKey;
    this.fromEmail = fromEmail;
  }

  async send(msg: OutboundEmail): Promise<SentEmail> {
    const body: Record<string, unknown> = {
      from: msg.from || this.fromEmail,
      to: [msg.to],
      subject: msg.subject,
      // Resend accepts either `html` or `text`. We send text; a markdown
      // renderer could be added later if we want to polish.
      text: msg.body_markdown,
      headers: {
        // Custom header used for thread correlation on inbound webhook.
        "X-Bonsai-Thread-Id": msg.thread_id,
        ...(msg.in_reply_to ? { "In-Reply-To": msg.in_reply_to, References: msg.in_reply_to } : {}),
      },
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content).toString("base64"),
      })),
      ...(msg.bcc && msg.bcc.length > 0 ? { bcc: msg.bcc } : {}),
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Resend send failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id: string };
    const sent: SentEmail = {
      message_id: data.id ?? newId("msg"),
      sent_at: new Date().toISOString(),
      to: msg.to,
      from: msg.from || this.fromEmail,
      subject: msg.subject,
      body_markdown: msg.body_markdown,
      thread_id: msg.thread_id,
      in_reply_to: msg.in_reply_to,
      bcc: msg.bcc,
    };
    const thread = loadThread(msg.thread_id);
    thread.outbound.push(sent);
    saveThread(thread);
    return sent;
  }

  async fetchInbound(thread_id: string, since: string): Promise<InboundEmail[]> {
    // Inbound is populated by the webhook handler (see src/server/webhooks.ts),
    // which appends to the same on-disk thread file. We just read that file.
    const thread = loadThread(thread_id);
    const sinceMs = since ? Date.parse(since) : 0;
    return thread.inbound.filter((m) => Date.parse(m.received_at) > sinceMs);
  }
}

/** Factory: returns ResendEmailClient if env is set, else MockEmailClient. */
export async function autoEmailClient(): Promise<EmailClient> {
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) {
    return new ResendEmailClient();
  }
  const { MockEmailClient } = await import("./email-mock.ts");
  return new MockEmailClient();
}

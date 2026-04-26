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
import { stripMarkdown } from "../lib/strip-markdown.ts";

/**
 * Build a display-name + address From line. The verified operator address
 * (`appeals@your-domain.com`) is the wire sender; the user's email is
 * woven into the display name so the rep sees who Bonsai is acting for.
 * Examples:
 *   verified = "Bonsai <appeals@x.com>", user = "alex@example.com"
 *     → "Bonsai (for alex@example.com) <appeals@x.com>"
 *   verified = "appeals@x.com", user undefined
 *     → "appeals@x.com"
 * Falls back to the verified address alone when the user email isn't
 * known. The returned string is RFC-2822-shaped, which Resend accepts.
 */
function withDisplayName(verified: string, userEmail?: string): string {
  if (!userEmail) return verified;
  // Strip any existing display name / angle brackets from the verified
  // address so we can wrap it cleanly. Accept "Name <addr>" or just "addr".
  const m = verified.match(/^\s*(?:(.+?)\s+)?<\s*([^>]+)\s*>\s*$/);
  const baseName = m?.[1]?.trim() || "Bonsai";
  const baseAddr = (m?.[2] ?? verified).trim();
  return `${baseName} (for ${userEmail}) <${baseAddr}>`;
}

export class ResendEmailClient implements EmailClient {
  private apiKey: string;
  private fromEmail: string;
  /** Optional override for the on-disk thread mailbox. The webhook
   * handler (unauthenticated, no AsyncLocalStorage user context) passes
   * the per-user dir explicitly here. Inside an authenticated request
   * `loadThread` / `saveThread` fall back to `currentUserPaths()`. */
  private threadsDir: string | undefined;

  constructor(opts?: { apiKey?: string; fromEmail?: string; threadsDir?: string }) {
    const apiKey = opts?.apiKey ?? process.env.RESEND_API_KEY;
    const fromEmail =
      opts?.fromEmail ?? process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL;
    if (!apiKey) throw new Error("ResendEmailClient: RESEND_API_KEY not set");
    if (!fromEmail) {
      throw new Error("ResendEmailClient: RESEND_FROM (or legacy RESEND_FROM_EMAIL) not set");
    }
    this.apiKey = apiKey;
    this.fromEmail = fromEmail;
    this.threadsDir = opts?.threadsDir;
  }

  async send(msg: OutboundEmail): Promise<SentEmail> {
    // The actual SMTP From must always be the operator's verified Resend
    // sender. `msg.from` (the user's account email) gets ignored for the
    // wire — we keep it on SentEmail purely for display, and surface the
    // user's identity in the From's display name so the rep sees
    // "Bonsai Operator (via Bonsai) <appeals@your-domain.com>".
    const wireFrom = withDisplayName(this.fromEmail, msg.from);
    // Defensive: even though the negotiator + humanizer prompts forbid
    // markdown, run the body through stripMarkdown() before it hits the
    // wire so any drift (e.g. a stray `**bold**`) doesn't render as
    // literal asterisks in Gmail/Outlook.
    const wireText = stripMarkdown(msg.body_text);
    const body: Record<string, unknown> = {
      from: wireFrom,
      to: [msg.to],
      subject: msg.subject,
      // Resend accepts either `html` or `text`. We send text; a markdown
      // renderer could be added later if we want to polish.
      text: wireText,
      headers: {
        // Custom header used for thread correlation on inbound webhook.
        "X-Bonsai-Thread-Id": msg.thread_id,
        ...(msg.in_reply_to ? { "In-Reply-To": msg.in_reply_to, References: msg.in_reply_to } : {}),
      },
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content).toString("base64"),
      })),
      ...(msg.cc && msg.cc.length > 0 ? { cc: msg.cc } : {}),
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
      from: wireFrom,
      subject: msg.subject,
      body_text: wireText,
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
    // Inbound is populated by the webhook handler (see src/server/webhooks.ts),
    // which appends to the same on-disk thread file. We just read that file.
    const thread = loadThread(thread_id, this.threadsDir);
    const sinceMs = since ? Date.parse(since) : 0;
    return thread.inbound.filter((m) => Date.parse(m.received_at) > sinceMs);
  }
}

let warnedMockMode = false;

/** Factory: returns ResendEmailClient if env is set, else MockEmailClient.
 * `threadsDir` overrides the per-user default — used by the webhook
 * handler, which is unauthenticated and resolves the dir from the on-disk
 * thread file directly. */
export async function autoEmailClient(threadsDir?: string): Promise<EmailClient> {
  const fromEmail = process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL;
  if (process.env.RESEND_API_KEY && fromEmail) {
    return new ResendEmailClient({ threadsDir, fromEmail });
  }
  if (!warnedMockMode) {
    console.warn(
      "[email] RESEND_API_KEY or RESEND_FROM unset — using MockEmailClient (no real outbound). " +
        "Set both in .env to enable real email delivery.",
    );
    warnedMockMode = true;
  }
  const { MockEmailClient } = await import("./email-mock.ts");
  return new MockEmailClient(threadsDir);
}

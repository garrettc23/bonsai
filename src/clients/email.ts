/**
 * Email client abstraction.
 *
 * Two impls:
 *   - ResendEmailClient: sends real email via Resend API. Requires
 *     RESEND_API_KEY + RESEND_FROM_EMAIL env vars.
 *   - MockEmailClient: writes to a local mailbox file. Used for testing and
 *     when creds aren't set. Matches the same shape so the negotiator
 *     doesn't know (or care) which it's talking to.
 *
 * The negotiator logic is 100% deterministic around this interface. Swap
 * the client, the conversation still works.
 */

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  body_text: string;
  /** Thread correlation — same value on every message in the same dispute. */
  thread_id: string;
  /** Plain-text attachment. Used to attach the structured appeal JSON. */
  attachments?: Array<{ filename: string; content: string }>;
  /** Set when this is a reply; threading headers. */
  in_reply_to?: string;
  /** CC recipients — typically the user's own email. Visible to the
   * billing office on purpose: shows there's a real account holder on
   * the line (legitimacy + deliverability) and lets the rep Reply-All so
   * the user sees replies natively. The user-bypass case (rep clicks
   * Reply not Reply-All) is covered by a backstop forward in the inbound
   * webhook. */
  cc?: string[];
}

export interface SentEmail {
  message_id: string;
  sent_at: string;
  to: string;
  from: string;
  subject: string;
  body_text: string;
  thread_id: string;
  in_reply_to?: string;
  cc?: string[];
}

export interface InboundEmail {
  message_id: string;
  received_at: string;
  from: string;
  to: string;
  subject: string;
  body_text: string;
  thread_id: string;
  in_reply_to?: string;
}

export interface EmailClient {
  /** Send an email. Throws on transport failure. */
  send(msg: OutboundEmail): Promise<SentEmail>;
  /**
   * Poll for inbound emails on a thread. For Resend this would be an inbox
   * queue populated by the inbound webhook; for Mock it's whatever the
   * simulator has written.
   */
  fetchInbound(thread_id: string, since: string): Promise<InboundEmail[]>;
}

/** Generate a random thread id / message id. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

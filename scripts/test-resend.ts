/**
 * Resend deliverability smoke test.
 *
 * Sends one real outbound through the production Resend shape (verified
 * sender, "Bonsai (for <user>)" display name, custom X-Bonsai-Thread-Id
 * header, optional CC) and prints the Resend message ID on success or a
 * full error body on failure. Use it to verify a recipient lands in inbox
 * (not spam) without spinning up a fake bill and clicking through audit
 * → approve → negotiation. Sends a real email — pick a real recipient.
 *
 * Usage:
 *   bun run test-resend you@example.com
 *   bun run test-resend billing@example.com you@example.com
 *                       └── to (billing dept)   └── cc (account email)
 *
 * Env required:
 *   RESEND_API_KEY  — re_... key from resend.com/api-keys
 *   RESEND_FROM     — verified sender, e.g. "Bonsai <appeals@your-domain.com>"
 *
 * What to check:
 *   - The Resend dashboard (resend.com/emails) shows the message as
 *     "delivered" and not "bounced" or "queued indefinitely".
 *   - The recipient inbox has the message in the primary tab — not spam,
 *     not promotions. If it lands in spam, the verified domain's SPF or
 *     DKIM is misconfigured, or the sender reputation is too low.
 *   - The From line on the received email reads:
 *       "Bonsai (for <recipient-or-cc>) <appeals@your-domain.com>"
 *     If it shows the raw verified address only, the display-name wrap
 *     isn't firing — bug in withDisplayName().
 */
import "../src/env.ts";

const recipient = process.argv[2];
const ccArg = process.argv[3];

if (!recipient) {
  console.error("Usage: bun run test-resend <recipient-email> [<cc-email>]");
  console.error("Example: bun run test-resend you@example.com");
  process.exit(2);
}

const apiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL;

if (!apiKey) {
  console.error("RESEND_API_KEY is not set. Add it to .env or your shell.");
  process.exit(2);
}
if (!fromEmail) {
  console.error("RESEND_FROM is not set. Add it to .env or your shell.");
  console.error("Example: RESEND_FROM='Bonsai <appeals@your-domain.com>'");
  process.exit(2);
}

// Mirror the production From-line wrap so spam/inbox placement reflects
// what real Bonsai outbound looks like.
function withDisplayName(verified: string, userEmail: string): string {
  const m = verified.match(/^\s*(?:(.+?)\s+)?<\s*([^>]+)\s*>\s*$/);
  const baseName = m?.[1]?.trim() || "Bonsai";
  const baseAddr = (m?.[2] ?? verified).trim();
  return `${baseName} (for ${userEmail}) <${baseAddr}>`;
}

const wireFrom = withDisplayName(fromEmail, ccArg ?? recipient);
const threadId = `test_resend_${Date.now().toString(36)}`;
const sentAt = new Date().toISOString();

const body: Record<string, unknown> = {
  from: wireFrom,
  to: [recipient],
  subject: "Bonsai Resend deliverability test",
  text: [
    "Hi — this is a deliverability smoke test from Bonsai.",
    "",
    "If you received this in your inbox (not spam, not promotions),",
    "the Resend integration is configured correctly: the verified sender",
    `is reachable, the From-line display name renders, and the recipient`,
    `(${recipient}) accepts mail from this domain.`,
    "",
    `Sent at: ${sentAt}`,
    `Thread ID: ${threadId}`,
    "",
    "No reply needed.",
  ].join("\n"),
  headers: {
    "X-Bonsai-Thread-Id": threadId,
  },
  ...(ccArg ? { cc: [ccArg] } : {}),
};

console.log(`-> sending to ${recipient}${ccArg ? ` (cc ${ccArg})` : ""}`);
console.log(`-> from ${wireFrom}`);

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  const errText = await res.text();
  console.error(`\nFAILED ${res.status} ${res.statusText}`);
  console.error(errText);
  console.error("\nCommon causes:");
  console.error("  403 / restricted: Resend free tier — only verified addresses can be recipients");
  console.error("  422 / domain not verified: verify RESEND_FROM's domain at resend.com/domains");
  console.error("  401: bad RESEND_API_KEY");
  console.error("  429: rate limited");
  process.exit(1);
}

const data = (await res.json()) as { id?: string };
console.log(`\nOK Resend accepted the message`);
console.log(`   message_id: ${data.id ?? "<missing>"}`);
console.log(`   thread_id:  ${threadId}`);
console.log(`   sent_at:    ${sentAt}`);
console.log(`\nNext: check ${recipient}'s inbox AND the Resend dashboard`);
console.log(`   https://resend.com/emails/${data.id ?? ""}`);
console.log(`If status flips to 'delivered' but inbox is empty, it landed in spam.`);

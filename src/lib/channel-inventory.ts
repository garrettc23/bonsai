/**
 * Boot-time inventory of which REAL outbound channels are armed.
 *
 * The audit found "simulated vs real" was ambiguous: the default build
 * never contacts a vendor, but nothing said so at a glance. This makes the
 * posture explicit in the boot log — an operator can see immediately whether
 * this process can actually email/call a billing department or is running as
 * a sandbox.
 *
 * Pure: reads env, returns booleans + a one-line summary. No side effects
 * (the caller does the logging), so it's trivially testable.
 */
export interface ChannelInventory {
  /** Real email send via Resend (needs API key + a verified From). */
  email_real: boolean;
  /** Real outbound phone call via ElevenLabs + Twilio. */
  voice_real: boolean;
  /** Cross-modal fact-check / adversarial gates are enabled. */
  crossmodal: boolean;
  /** Cross-user provider brain writes are enabled. */
  brain: boolean;
}

function has(env: Record<string, string | undefined>, key: string): boolean {
  return Boolean(env[key] && env[key]!.trim());
}

export function channelInventory(
  env: Record<string, string | undefined> = process.env,
): ChannelInventory {
  return {
    email_real: has(env, "RESEND_API_KEY") && (has(env, "RESEND_FROM") || has(env, "RESEND_FROM_EMAIL")),
    voice_real:
      has(env, "ELEVENLABS_API_KEY") &&
      has(env, "ELEVENLABS_TWILIO_PHONE_NUMBER_ID") &&
      has(env, "ELEVENLABS_WEBHOOK_BASE"),
    crossmodal: env.BONSAI_CROSSMODAL === "1",
    brain: env.BONSAI_BRAIN === "1" && has(env, "BONSAI_BRAIN_HMAC_KEY"),
  };
}

/** One-line, log-friendly summary. */
export function channelInventoryLine(inv: ChannelInventory = channelInventory()): string {
  const f = (on: boolean) => (on ? "REAL" : "SIMULATED");
  const g = (on: boolean) => (on ? "on" : "off");
  return (
    `[channels] email: ${f(inv.email_real)} | voice: ${f(inv.voice_real)} | ` +
    `cross-modal fact-check: ${g(inv.crossmodal)} | provider-brain: ${g(inv.brain)}`
  );
}

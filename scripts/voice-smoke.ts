/**
 * Voice smoke test — places a real ElevenLabs outbound call against an
 * operator-owned test number, then polls the conversation meta file until
 * the agent calls `end_call`. Prints the final transcript JSON so a human
 * can spot-check the round-trip.
 *
 * Required env (set in your shell before invocation):
 *   ANTHROPIC_API_KEY                   — for the analyzer
 *   ELEVENLABS_API_KEY                  — voice client
 *   ELEVENLABS_TWILIO_PHONE_NUMBER_ID   — caller-id (linked Twilio number)
 *   ELEVENLABS_WEBHOOK_BASE             — public URL the agent posts back to
 *   ELEVENLABS_WEBHOOK_SECRET           — Bearer secret for webhook auth
 *   BONSAI_VOICE_SMOKE_TO               — destination phone (E.164)
 *   BONSAI_VOICE_SMOKE_USER_EMAIL       — existing Bonsai user to attribute the call to
 *
 * Optional:
 *   VOICE_DRY_RUN=true                  — skip the actual ElevenLabs API call
 *
 * Usage:
 *   bun run scripts/voice-smoke.ts             # bill-001 / eob-001 by default
 *   bun run scripts/voice-smoke.ts bill-002 eob-002
 */
import "../src/env.ts";
import { analyze } from "../src/analyzer.ts";
import { loadFixtureAnalyzeInput } from "../src/lib/fixture-audit.ts";
import { dialVoiceForUser } from "../src/server/voice-dial.ts";
import { getUserByEmail } from "../src/lib/auth.ts";
import { ensureUserDirs, userPaths } from "../src/lib/user-paths.ts";
import { withUserContext } from "../src/lib/user-context.ts";
import { loadConversationMeta } from "../src/lib/call-store.ts";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
  throw new Error(msg);
}

function require_env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) die(`[voice-smoke] missing required env var: ${name}`);
  return v;
}

const billName = process.argv[2] ?? "bill-001";
const eobName = process.argv[3] ?? "eob-001";

const dryRun = process.env.VOICE_DRY_RUN === "true";

if (!dryRun) {
  require_env("ELEVENLABS_API_KEY");
  require_env("ELEVENLABS_TWILIO_PHONE_NUMBER_ID");
}
const toNumber = require_env("BONSAI_VOICE_SMOKE_TO");
const userEmail = require_env("BONSAI_VOICE_SMOKE_USER_EMAIL");
require_env("ELEVENLABS_WEBHOOK_BASE");
if (!dryRun) require_env("ELEVENLABS_WEBHOOK_SECRET");

const user =
  getUserByEmail(userEmail) ??
  die(`[voice-smoke] no Bonsai user with email ${userEmail}; sign up first then re-run.`);
ensureUserDirs(userPaths(user.id));

console.log(`[voice-smoke] analyzing ${billName} / ${eobName}…`);
const analyzer = await analyze(await loadFixtureAnalyzeInput(billName, eobName));
console.log(
  `[voice-smoke] analyzer headline: ${analyzer.summary.headline} (HIGH=$${analyzer.summary.high_confidence_total.toFixed(2)})`,
);

const result = await withUserContext(user, async () =>
  dialVoiceForUser(user, {
    run_id: `smoke_${Date.now().toString(36)}`,
    analyzer,
    provider_phone: toNumber,
    skip_rate_limit: true,
  }),
);

if (!result.ok) {
  die(`[voice-smoke] dial failed (${result.status}): ${result.error}`);
}

console.log(
  `[voice-smoke] dial ok — agent_id=${result.agent_id} cached=${result.agent_cached} dry_run=${result.dry_run} conversation_id=${result.conversation_id}`,
);

const conversationId = result.conversation_id;

if (result.dry_run) {
  console.log(`[voice-smoke] dry-run mode — no real call placed; meta envelope at:`);
  console.log(`  ${userPaths(user.id).callsDir}/${conversationId}.json`);
  console.log(`[voice-smoke] hit each /webhooks/voice/<tool> by hand to validate round-trip.`);
  process.exit(0);
}

const deadlineMs = Date.now() + 30 * 60 * 1000;
console.log(`[voice-smoke] polling for end_call up to 30 min…`);
while (Date.now() < deadlineMs) {
  const meta = loadConversationMeta(user.id, conversationId);
  if (meta?.status === "ended" || meta?.status === "failed") {
    console.log(`\n─── Final meta ─────────────────────────────────`);
    console.log(JSON.stringify(meta, null, 2));
    process.exit(meta.status === "failed" ? 1 : 0);
  }
  await new Promise((r) => setTimeout(r, 5_000));
}

die(`[voice-smoke] timed out waiting for end_call`);

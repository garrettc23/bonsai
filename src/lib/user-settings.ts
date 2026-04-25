/**
 * User-editable settings persisted to `out/user-settings.json`.
 *
 * Two independent sections:
 *   - profile: the human (name, contact, consent). Populated from the Profile tab.
 *   - tune:    the agent (tone, channels, floor, notifications). Populated from the Tune your agent tab.
 *
 * `.env` is the source of truth for API keys and other integration creds —
 * this file only stores what the user explicitly sets through the UI.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SETTINGS_DIR = join(ROOT, "out");
const SETTINGS_PATH = join(SETTINGS_DIR, "user-settings.json");

export type AgentTone = "polite" | "firm" | "aggressive";

interface PersistedSettings {
  profile?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    address?: string;
    dob?: string;
    ssn_last4?: string;
    drivers_license?: string;
    authorized?: boolean;
    authorized_at?: string;
    hipaa_acknowledged?: boolean;
    hipaa_acknowledged_at?: string;
  };
  tune?: {
    tone?: AgentTone;
    channel_email?: boolean;
    channel_sms?: boolean;
    channel_voice?: boolean;
    floor_pct?: number;
    email_digest?: boolean;
    mobile_alerts?: boolean;
  };
  integrations?: {
    anthropic_api_key?: string;
    resend_api_key?: string;
    resend_from?: string;
    elevenlabs_api_key?: string;
    elevenlabs_agent_id?: string;
    elevenlabs_webhook_base?: string;
  };
  // Legacy keys from the old Account card — read once during migration.
  account_name?: string;
  account_email?: string;
  account_phone?: string;
  notify_email_digest?: boolean;
  notify_mobile_alerts?: boolean;
}

function load(): PersistedSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as PersistedSettings;
  } catch {
    return {};
  }
}

function save(s: PersistedSettings): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

export interface ProfileConfig {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  dob: string | null;
  ssn_last4: string | null;
  drivers_license: string | null;
  authorized: boolean;
  authorized_at: string | null;
  hipaa_acknowledged: boolean;
  hipaa_acknowledged_at: string | null;
}

export function getProfileConfig(): ProfileConfig {
  const s = load();
  const p = s.profile ?? {};
  // Migrate legacy account_name → first/last on first read.
  let firstName = p.first_name ?? null;
  let lastName = p.last_name ?? null;
  if (!firstName && !lastName && s.account_name) {
    const parts = s.account_name.trim().split(/\s+/);
    firstName = parts[0] ?? null;
    lastName = parts.slice(1).join(" ") || null;
  }
  return {
    first_name: firstName?.trim() || null,
    last_name: lastName?.trim() || null,
    email: p.email?.trim() || s.account_email?.trim() || null,
    phone: p.phone?.trim() || s.account_phone?.trim() || null,
    address: p.address?.trim() || null,
    dob: p.dob?.trim() || null,
    ssn_last4: p.ssn_last4?.trim() || null,
    drivers_license: p.drivers_license?.trim() || null,
    authorized: !!p.authorized,
    authorized_at: p.authorized_at ?? null,
    hipaa_acknowledged: !!p.hipaa_acknowledged,
    hipaa_acknowledged_at: p.hipaa_acknowledged_at ?? null,
  };
}

export function setProfileConfig(
  input: Partial<Omit<ProfileConfig, "authorized_at" | "hipaa_acknowledged_at">>,
): void {
  const current = load();
  const next: PersistedSettings = { ...current, profile: { ...(current.profile ?? {}) } };
  const p = next.profile!;
  const applyStr = (
    key: "first_name" | "last_name" | "email" | "phone" | "address" | "dob" | "ssn_last4" | "drivers_license",
    v: string | null | undefined,
  ) => {
    if (v === undefined) return;
    const t = (v ?? "").trim();
    if (t) p[key] = t; else delete p[key];
  };
  applyStr("first_name", input.first_name);
  applyStr("last_name", input.last_name);
  applyStr("email", input.email);
  applyStr("phone", input.phone);
  applyStr("address", input.address);
  applyStr("dob", input.dob);
  if (input.ssn_last4 !== undefined) {
    const digits = (input.ssn_last4 ?? "").replace(/\D/g, "").slice(0, 4);
    if (digits.length === 4) p.ssn_last4 = digits;
    else delete p.ssn_last4;
  }
  applyStr("drivers_license", input.drivers_license);
  // Only stamp the timestamp on a *transition* into authorized, not on every
  // save — otherwise editing an unrelated field (address, DOB) would advance
  // the consent date and the displayed "Signed: <date>" would lie.
  if (input.authorized !== undefined) {
    const wasAuthorized = !!p.authorized;
    const willAuthorize = !!input.authorized;
    p.authorized = willAuthorize;
    if (willAuthorize && !wasAuthorized) p.authorized_at = new Date().toISOString();
    else if (!willAuthorize) delete p.authorized_at;
  }
  if (input.hipaa_acknowledged !== undefined) {
    const wasAcked = !!p.hipaa_acknowledged;
    const willAck = !!input.hipaa_acknowledged;
    p.hipaa_acknowledged = willAck;
    if (willAck && !wasAcked) p.hipaa_acknowledged_at = new Date().toISOString();
    else if (!willAck) delete p.hipaa_acknowledged_at;
  }
  save(next);
}

export interface TuneConfig {
  tone: AgentTone;
  channels: { email: boolean; sms: boolean; voice: boolean };
  /** Target discount off the original balance, 0–100. The floor is
   * derived at run-time from this by the caller. */
  floor_pct: number;
  email_digest: boolean;
  mobile_alerts: boolean;
}

export function getTuneConfig(): TuneConfig {
  const s = load();
  const t = s.tune ?? {};
  return {
    tone: t.tone ?? "firm",
    channels: {
      email: t.channel_email !== false,
      sms: false,
      voice: t.channel_voice !== false,
    },
    floor_pct: typeof t.floor_pct === "number" ? t.floor_pct : 50,
    email_digest:
      t.email_digest !== undefined ? !!t.email_digest : s.notify_email_digest !== false,
    mobile_alerts:
      t.mobile_alerts !== undefined ? !!t.mobile_alerts : s.notify_mobile_alerts !== false,
  };
}

export interface IntegrationsConfig {
  anthropic_api_key: string | null;
  resend_api_key: string | null;
  resend_from: string | null;
  elevenlabs_api_key: string | null;
  elevenlabs_agent_id: string | null;
  elevenlabs_webhook_base: string | null;
}

type IntegrationKey = keyof IntegrationsConfig;

const INTEGRATION_KEYS: IntegrationKey[] = [
  "anthropic_api_key",
  "resend_api_key",
  "resend_from",
  "elevenlabs_api_key",
  "elevenlabs_agent_id",
  "elevenlabs_webhook_base",
];

export function getIntegrationsConfig(): IntegrationsConfig {
  const s = load();
  const i = s.integrations ?? {};
  return {
    anthropic_api_key: i.anthropic_api_key?.trim() || null,
    resend_api_key: i.resend_api_key?.trim() || null,
    resend_from: i.resend_from?.trim() || null,
    elevenlabs_api_key: i.elevenlabs_api_key?.trim() || null,
    elevenlabs_agent_id: i.elevenlabs_agent_id?.trim() || null,
    elevenlabs_webhook_base: i.elevenlabs_webhook_base?.trim() || null,
  };
}

/**
 * Apply integration writes. For each key, `undefined` means "no change",
 * an empty string means "clear the stored value", and any other string is
 * saved. Pushes the resulting effective value into process.env so running
 * services pick it up on the next API call without a server restart.
 */
export function setIntegrationsConfig(
  input: Partial<Record<IntegrationKey, string | null | undefined>>,
): void {
  const current = load();
  const next: PersistedSettings = {
    ...current,
    integrations: { ...(current.integrations ?? {}) },
  };
  const ints = next.integrations!;
  for (const k of INTEGRATION_KEYS) {
    const v = input[k];
    if (v === undefined) continue;
    const trimmed = (v ?? "").trim();
    if (trimmed) ints[k] = trimmed;
    else delete ints[k];
  }
  save(next);
  applyIntegrationsToEnv();
}

/**
 * On server startup (and after every save) push user-settings integration
 * values into process.env. `.env` stays the canonical source on a fresh
 * clone; once the user sets a value through the UI it wins.
 */
export function applyIntegrationsToEnv(): void {
  const i = getIntegrationsConfig();
  const map: Array<[string | null, string]> = [
    [i.anthropic_api_key, "ANTHROPIC_API_KEY"],
    [i.resend_api_key, "RESEND_API_KEY"],
    [i.resend_from, "RESEND_FROM"],
    // Two call sites read RESEND_FROM_EMAIL — populate both so either works.
    [i.resend_from, "RESEND_FROM_EMAIL"],
    [i.elevenlabs_api_key, "ELEVENLABS_API_KEY"],
    [i.elevenlabs_agent_id, "ELEVENLABS_AGENT_ID"],
    [i.elevenlabs_webhook_base, "ELEVENLABS_WEBHOOK_BASE"],
  ];
  for (const [value, envKey] of map) {
    if (value) process.env[envKey] = value;
  }
}

export function setTuneConfig(input: {
  tone?: AgentTone;
  channels?: Partial<{ email: boolean; sms: boolean; voice: boolean }>;
  floor_pct?: number;
  email_digest?: boolean;
  mobile_alerts?: boolean;
}): void {
  const current = load();
  const next: PersistedSettings = { ...current, tune: { ...(current.tune ?? {}) } };
  const t = next.tune!;
  if (input.tone && ["polite", "firm", "aggressive"].includes(input.tone)) t.tone = input.tone;
  if (input.channels) {
    if (input.channels.email !== undefined) t.channel_email = !!input.channels.email;
    if (input.channels.sms !== undefined) t.channel_sms = !!input.channels.sms;
    if (input.channels.voice !== undefined) t.channel_voice = !!input.channels.voice;
  }
  if (typeof input.floor_pct === "number" && isFinite(input.floor_pct)) {
    t.floor_pct = Math.max(0, Math.min(100, input.floor_pct));
  }
  if (input.email_digest !== undefined) t.email_digest = !!input.email_digest;
  if (input.mobile_alerts !== undefined) t.mobile_alerts = !!input.mobile_alerts;
  save(next);
}

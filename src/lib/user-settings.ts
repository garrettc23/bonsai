/**
 * User-editable settings persisted to `out/user-settings.json`.
 *
 * Overlays `.env` for a handful of keys the user can configure from the
 * Settings UI without restarting the server. Today: Telegram credentials.
 * Fall-through order per key:
 *   1. user-settings.json (UI-edited)
 *   2. process.env (.env file)
 *   3. null (unset)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SETTINGS_DIR = join(ROOT, "out");
const SETTINGS_PATH = join(SETTINGS_DIR, "user-settings.json");

interface UserSettings {
  telegram_bot_token?: string;
  telegram_chat_id?: string;
  account_name?: string;
  account_email?: string;
  account_phone?: string;
  notify_email_digest?: boolean;
  notify_mobile_alerts?: boolean;
}

function load(): UserSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as UserSettings;
  } catch {
    return {};
  }
}

function save(s: UserSettings): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function envFallback(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

export interface TelegramConfig {
  botToken: string | null;
  chatId: string | null;
}

export function getTelegramConfig(): TelegramConfig {
  const s = load();
  return {
    botToken: s.telegram_bot_token?.trim() || envFallback("TELEGRAM_BOT_TOKEN") || null,
    chatId: s.telegram_chat_id?.trim() || envFallback("TELEGRAM_CHAT_ID") || null,
  };
}

export function setTelegramConfig(input: { botToken?: string | null; chatId?: string | null }): void {
  const current = load();
  const next: UserSettings = { ...current };
  if (input.botToken !== undefined) {
    const t = (input.botToken ?? "").trim();
    if (t) next.telegram_bot_token = t; else delete next.telegram_bot_token;
  }
  if (input.chatId !== undefined) {
    const c = (input.chatId ?? "").trim();
    if (c) next.telegram_chat_id = c; else delete next.telegram_chat_id;
  }
  save(next);
}

export interface AccountConfig {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Weekly email digest of savings + pending approvals. Default on. */
  email_digest: boolean;
  /** Mobile push alerts for real-time approval needs. Default on. */
  mobile_alerts: boolean;
}

export function getAccountConfig(): AccountConfig {
  const s = load();
  return {
    name: s.account_name?.trim() || null,
    email: s.account_email?.trim() || null,
    phone: s.account_phone?.trim() || null,
    email_digest: s.notify_email_digest !== false, // default true
    mobile_alerts: s.notify_mobile_alerts !== false, // default true
  };
}

export function setAccountConfig(input: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  email_digest?: boolean;
  mobile_alerts?: boolean;
}): void {
  const current = load();
  const next: UserSettings = { ...current };
  const applyStr = (key: "account_name" | "account_email" | "account_phone", v: string | null | undefined) => {
    if (v === undefined) return;
    const t = (v ?? "").trim();
    if (t) next[key] = t; else delete next[key];
  };
  applyStr("account_name", input.name);
  applyStr("account_email", input.email);
  applyStr("account_phone", input.phone);
  if (input.email_digest !== undefined) next.notify_email_digest = !!input.email_digest;
  if (input.mobile_alerts !== undefined) next.notify_mobile_alerts = !!input.mobile_alerts;
  save(next);
}

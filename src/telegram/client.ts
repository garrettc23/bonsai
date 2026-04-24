/**
 * Thin Telegram Bot API client. No SDK dependency — the surface we need
 * (sendMessage, getUpdates) is straightforward over fetch.
 */

import { getTelegramConfig } from "../lib/user-settings.ts";

const TG_BASE = "https://api.telegram.org";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string; first_name?: string; username?: string };
    date: number;
    text?: string;
  };
}

function token(): string | null {
  return getTelegramConfig().botToken;
}

export function telegramEnabled(): boolean {
  return token() !== null;
}

/** Send a plain-text or Markdown message to a chat. */
export async function sendMessage(
  chatId: number | string,
  text: string,
  opts: { parseMode?: "Markdown" | "MarkdownV2" | "HTML" } = {},
): Promise<void> {
  const t = token();
  if (!t) return; // silent no-op when the bot isn't configured
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  const res = await fetch(`${TG_BASE}/bot${t}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    console.error("[telegram] sendMessage failed", res.status, msg.slice(0, 200));
  }
}

/** Long-polling getUpdates. Returns the list of new updates since offset. */
export async function getUpdates(offset: number, timeoutSec = 25): Promise<TelegramUpdate[]> {
  const t = token();
  if (!t) return [];
  const url = new URL(`${TG_BASE}/bot${t}/getUpdates`);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("timeout", String(timeoutSec));
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout((timeoutSec + 5) * 1000),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error("[telegram] getUpdates failed", res.status, msg.slice(0, 200));
      return [];
    }
    const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    if (!data.ok || !data.result) return [];
    return data.result;
  } catch (err) {
    // Timeout is expected when no new messages arrive — only log real errors.
    if ((err as { name?: string })?.name !== "TimeoutError") {
      console.error("[telegram] getUpdates error", err);
    }
    return [];
  }
}

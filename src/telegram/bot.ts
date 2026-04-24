/**
 * Long-polling Telegram bot. Runs alongside Bun.serve — no public URL or
 * webhook needed. On each incoming message, routes it through the brain
 * and sends the reply back. Processed update_ids are tracked in-memory.
 */
import { getUpdates, sendMessage, telegramEnabled } from "./client.ts";
import { getTelegramConfig, setTelegramConfig } from "../lib/user-settings.ts";
import { routeInboundMessage } from "./route-message.ts";

let running = false;

export function startTelegramBot(): void {
  if (!telegramEnabled()) return;
  if (running) return;
  running = true;
  void pollLoop();
  console.log("[telegram] bot polling started");
}

async function pollLoop(): Promise<void> {
  let offset = 0;
  // Discover the starting offset — skip any stale updates so we don't reply
  // to messages from previous runs.
  try {
    const initial = await getUpdates(0, 0);
    if (initial.length > 0) {
      offset = initial[initial.length - 1].update_id + 1;
    }
  } catch { /* ignore */ }

  while (running) {
    const updates = await getUpdates(offset, 25);
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text || !msg.chat?.id) continue;

      // If no chat_id is configured yet, adopt the first one we see. The
      // user just needs to paste the bot token in Settings; we discover
      // their chat_id from their first message.
      if (!getTelegramConfig().chatId) {
        setTelegramConfig({ chatId: String(msg.chat.id) });
        console.log(`[telegram] auto-captured chat_id ${msg.chat.id}`);
      }

      try {
        const reply = await routeInboundMessage({
          chatId: msg.chat.id,
          fromFirstName: msg.from?.first_name ?? null,
          text: msg.text,
        });
        if (reply) {
          await sendMessage(msg.chat.id, reply);
        }
      } catch (err) {
        console.error("[telegram] route error", err);
        await sendMessage(msg.chat.id, "Sorry, something went wrong on my end. Try again in a sec.");
      }
    }
  }
}

export function stopTelegramBot(): void {
  running = false;
}

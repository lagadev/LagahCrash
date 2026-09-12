import type { Env } from "../env";

const API = (env: Env, method: string) => `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

export async function tg(env: Env, method: string, body: Record<string, unknown>) {
  const res = await fetch(API(env, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Telegram API error on ${method}:`, await res.text());
  }
  return res.json().catch(() => null);
}

export function sendMessage(env: Env, chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

export function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {}
) {
  return tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

export function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string) {
  return tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

export function setWebhook(env: Env, url: string) {
  return tg(env, "setWebhook", { url, secret_token: env.WEBHOOK_SECRET });
}

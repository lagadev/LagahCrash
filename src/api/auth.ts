import type { Context } from "hono";
import type { Env } from "../env";
import { validateInitData, type TelegramWebAppUser } from "../utils/telegramAuth";

/**
 * Reads Telegram initData from the `X-Telegram-Init-Data` header (normal
 * fetch calls) — the gameApi's /ws route builds a fake header-bearing
 * request itself since a WebSocket handshake can't carry custom headers,
 * so this same function works for both.
 */
export async function authenticate(c: { req: { header: (k: string) => string | null | undefined }; env: Env }): Promise<TelegramWebAppUser | null> {
  const initData = c.req.header("X-Telegram-Init-Data");
  if (!initData) return null;
  return validateInitData(initData, c.env.BOT_TOKEN);
}

export function isAdmin(env: Env, userId: number): boolean {
  const ids = (env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  return ids.includes(userId);
}

/** Hono middleware-style guard for admin-only routes. */
export async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<TelegramWebAppUser | Response> {
  const user = await authenticate(c);
  if (!user) return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401 });
  if (!isAdmin(c.env, user.id)) {
    return new Response(JSON.stringify({ ok: false, error: "Forbidden" }), { status: 403 });
  }
  return user;
}

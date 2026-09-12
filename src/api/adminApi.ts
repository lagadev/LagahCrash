import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdmin } from "./auth";
import { ok, fail } from "../utils/response";
import { adminStats, resolveWithdrawal } from "../bot/db";
import { sendMessage } from "../bot/telegramApi";

export const adminApi = new Hono<{ Bindings: Env }>();

adminApi.use("*", async (c, next) => {
  const guard = await requireAdmin(c);
  if (guard instanceof Response) return guard;
  await next();
});

adminApi.get("/stats", async (c) => {
  const stats = await adminStats(c.env);
  return ok(stats);
});

// ---------------------------------------------------------------------------
// Game management — round history + the "force next crash point" override
// ---------------------------------------------------------------------------

adminApi.get("/game", async (c) => {
  const rounds = await c.env.DB.prepare(
    "SELECT * FROM rounds ORDER BY id DESC LIMIT 50"
  ).all();
  const control = await c.env.DB.prepare("SELECT forced_crash_point FROM game_control WHERE id = 1").first<{
    forced_crash_point: number | null;
  }>();
  return ok({ rounds: rounds.results, forcedCrashPoint: control?.forced_crash_point ?? null });
});

adminApi.post("/game/force-crash", async (c) => {
  const body = await c.req.json<{ multiplier: number }>().catch(() => null);
  const multiplier = Number(body?.multiplier);
  if (!multiplier || multiplier < 1) return fail("Enter a multiplier >= 1");
  await c.env.DB.prepare("UPDATE game_control SET forced_crash_point = ? WHERE id = 1").bind(multiplier).run();
  return ok({ forcedCrashPoint: multiplier });
});

adminApi.post("/game/clear-force-crash", async (c) => {
  await c.env.DB.prepare("UPDATE game_control SET forced_crash_point = NULL WHERE id = 1").run();
  return ok({});
});

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

adminApi.get("/withdrawals", async (c) => {
  const status = c.req.query("status") || "pending";
  const rows = await c.env.DB.prepare(
    "SELECT w.*, u.username FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.created_at DESC LIMIT 100"
  )
    .bind(status)
    .all();
  return ok({ withdrawals: rows.results });
});

adminApi.post("/withdrawals/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  const wd = await resolveWithdrawal(c.env, id, "approved");
  if (!wd) return fail("Not found", 404);
  await sendMessage(c.env, wd.user_id, `✅ Your withdrawal of ${wd.payout} ৳ has been approved and sent.`);
  return ok({ withdrawal: wd });
});

adminApi.post("/withdrawals/:id/reject", async (c) => {
  const id = Number(c.req.param("id"));
  const wd = await resolveWithdrawal(c.env, id, "rejected");
  if (!wd) return fail("Not found", 404);
  await sendMessage(c.env, wd.user_id, `❌ Your withdrawal request was rejected and the amount was refunded to your balance.`);
  return ok({ withdrawal: wd });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

adminApi.get("/users", async (c) => {
  const q = c.req.query("q");
  const rows = q
    ? await c.env.DB.prepare(
        "SELECT * FROM users WHERE CAST(id AS TEXT) LIKE ? OR username LIKE ? ORDER BY created_at DESC LIMIT 50"
      )
        .bind(`%${q}%`, `%${q}%`)
        .all()
    : await c.env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT 50").all();
  return ok({ users: rows.results });
});

adminApi.post("/users/:id/ban", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ banned: boolean }>().catch(() => ({ banned: true }));
  await c.env.DB.prepare("UPDATE users SET banned = ? WHERE id = ?").bind(body.banned ? 1 : 0, id).run();
  return ok({});
});

adminApi.post("/users/:id/adjust-balance", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ amount: number }>().catch(() => null);
  const amount = Number(body?.amount);
  if (!amount) return fail("Provide a non-zero amount");
  await c.env.DB.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(amount, id).run();
  return ok({});
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

adminApi.post("/broadcast", async (c) => {
  const body = await c.req.json<{ text: string }>().catch(() => null);
  if (!body?.text) return fail("Provide text");
  const users = await c.env.DB.prepare("SELECT id FROM users").all<{ id: number }>();
  let sent = 0;
  for (const u of users.results ?? []) {
    await sendMessage(c.env, u.id, body.text).then(() => sent++).catch(() => {});
  }
  return ok({ sent });
});

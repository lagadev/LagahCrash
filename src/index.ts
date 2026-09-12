import { Hono } from "hono";
import type { Env } from "./env";
import { gameApi } from "./api/gameApi";
import { adminApi } from "./api/adminApi";
import { depositApi } from "./api/depositApi";
import { handleUpdate } from "./bot/handlers";
import { setWebhook } from "./bot/telegramApi";

export { CrashRoom } from "./game/crashRoom";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/game", gameApi);
app.route("/api/admin", adminApi);
app.route("/api/deposit", depositApi);

// Telegram webhook — verify the secret token Telegram echoes back on every
// call (set via setWebhook's secret_token, see scripts below).
app.post("/webhook", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== c.env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await c.req.json().catch(() => null);
  if (update) {
    c.executionCtx.waitUntil(handleUpdate(c.env, update).catch((e) => console.error("handleUpdate failed", e)));
  }
  return new Response("ok");
});

// One-time convenience route to (re)point Telegram's webhook at this Worker.
// Visit https://<your-worker>/setup-webhook?token=<WEBHOOK_SECRET> once after deploying.
app.get("/setup-webhook", async (c) => {
  if (c.req.query("token") !== c.env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  const url = `${c.env.MINI_APP_BASE_URL}/webhook`;
  const res = await setWebhook(c.env, url);
  return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
});

// Fallback: if the Assets routing ever misses (e.g. local `wrangler dev`
// without an assets dev server), serve static files from here too.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

import { Hono } from "hono";
import type { Env } from "../env";
import { ok, fail } from "../utils/response";
import { verifyWebhook } from "../payment/paylink";
import { markDepositPaid } from "../bot/db";
import { sendMessage } from "../bot/telegramApi";

export const depositApi = new Hono<{ Bindings: Env }>();

/**
 * PayLink calls this the instant a payment is confirmed. Verifies the
 * signature (see src/payment/paylink.ts — pending the real docs snippet),
 * then credits the depositor's balance and pays the referrer's bonus.
 */
depositApi.post("/webhook", async (c) => {
  const verified = await verifyWebhook(c.env, c.req.raw.clone());
  if (!verified) return fail("Invalid webhook", 400);

  const refBonusPercent = Number(c.env.REF_BONUS_PERCENT || "10");
  const dep = await markDepositPaid(c.env, verified.invoiceId, refBonusPercent);
  if (!dep) return ok({ alreadyProcessed: true });

  await sendMessage(c.env, dep.user_id, `✅ Your deposit of ${dep.amount} ৳ has been credited to your balance!`);
  return ok({ credited: true });
});

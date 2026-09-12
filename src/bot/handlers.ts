import type { Env } from "../env";
import { sendMessage, editMessageText, answerCallbackQuery } from "./telegramApi";
import { mainKeyboard, profileInlineKeyboard, referInlineKeyboard, backOnlyKeyboard, depositPayKeyboard } from "./keyboards";
import { getOrCreateUser, getUser, setUserState, createWithdrawal, recordDeposit } from "./db";
import { createInvoice } from "../payment/paylink";

const fmt = (n: number) => `${Number(n ?? 0).toFixed(2)} ৳`;

function parseReferrer(startPayload: string | undefined): number | null {
  if (!startPayload) return null;
  const m = startPayload.match(/^ref_(\d+)$/);
  return m ? Number(m[1]) : null;
}

export async function handleUpdate(env: Env, update: any) {
  if (update.message) return handleMessage(env, update.message);
  if (update.callback_query) return handleCallbackQuery(env, update.callback_query);
}

async function handleMessage(env: Env, message: any) {
  const chatId = message.chat.id;
  const from = message.from;
  const text: string | undefined = message.text;

  if (text?.startsWith("/start")) {
    const payload = text.split(" ")[1];
    const referredBy = parseReferrer(payload);
    const user = await getOrCreateUser(env, from, referredBy && referredBy !== from.id ? referredBy : null);
    await setUserState(env, from.id, null);
    await sendMessage(
      env,
      chatId,
      `🚀 <b>Welcome to LagahCrashBot!</b>\n\nBet, watch the multiplier climb, and cash out before it crashes.\nUse the menu below to get started.`,
      { reply_markup: mainKeyboard(env, from.id) }
    );
    return;
  }

  const user = await getUser(env, from.id);
  if (!user) {
    await getOrCreateUser(env, from);
  }

  // ---- Mini App "+" (deposit) button, sent via Telegram.WebApp.sendData ----
  if (message.web_app_data?.data) {
    try {
      const payload = JSON.parse(message.web_app_data.data);
      if (payload.action === "deposit") {
        await setUserState(env, from.id, "awaiting_deposit_amount");
        await sendMessage(env, chatId, "💳 <b>Enter deposit amount (৳):</b>", { reply_markup: backOnlyKeyboard() });
        return;
      }
    } catch {}
  }

  // ---- Stateful chat flows (withdraw / deposit amount entry) ----
  if (user?.state === "awaiting_withdraw_amount" && text) {
    return handleWithdrawAmount(env, chatId, from.id, text);
  }
  if (user?.state === "awaiting_withdraw_wallet" && text) {
    return handleWithdrawWallet(env, chatId, from.id, text);
  }
  if (user?.state === "awaiting_deposit_amount" && text) {
    return handleDepositAmount(env, chatId, from.id, text);
  }

  // ---- Menu buttons ----
  if (text === "👤 Profile") return sendProfile(env, chatId, from.id);
  if (text === "👥 Refer & Earn") return sendRefer(env, chatId, from.id);
  if (text === "💸 Withdraw") return sendWithdrawPrompt(env, chatId, from.id);
}

async function handleCallbackQuery(env: Env, cq: any) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const userId = cq.from.id;
  const data = cq.data;

  if (data === "back_to_menu") {
    await setUserState(env, userId, null);
    await answerCallbackQuery(env, cq.id);
    await editMessageText(env, chatId, messageId, "🏠 Main menu — use the buttons below.");
    return;
  }

  if (data === "deposit") {
    await setUserState(env, userId, "awaiting_deposit_amount");
    await answerCallbackQuery(env, cq.id);
    await editMessageText(env, chatId, messageId, "💳 <b>Enter deposit amount (৳):</b>", {
      reply_markup: backOnlyKeyboard(),
    });
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

async function sendProfile(env: Env, chatId: number, userId: number) {
  const u = await getUser(env, userId);
  if (!u) return;
  const text =
    `👤 <b>Your Profile</b>\n\n` +
    `💰 Balance: <b>${fmt(u.balance)}</b>\n\n` +
    `📊 <b>Stats</b>\n` +
    `Wagered: ${fmt(u.total_wagered)}\n` +
    `Deposits: ${fmt(u.deposits_total)}\n` +
    `Withdrawals: ${fmt(u.withdrawals_total)}\n\n` +
    `👥 Total Refer: <b>${u.ref_count}</b>\n` +
    `💵 Refer Earnings: <b>${fmt(u.ref_earnings)}</b>`;
  await sendMessage(env, chatId, text, { reply_markup: profileInlineKeyboard() });
}

// ---------------------------------------------------------------------------
// Refer
// ---------------------------------------------------------------------------

async function sendRefer(env: Env, chatId: number, userId: number) {
  const u = await getUser(env, userId);
  if (!u) return;
  const link = `https://t.me/${env.BOT_USERNAME}?start=ref_${userId}`;
  const pct = env.REF_BONUS_PERCENT || "10";
  const text =
    `👥 <b>Refer & Earn</b>\n\n` +
    `🎁 Refer Bonus: <b>${pct}%</b> of every referral's deposit\n` +
    `👤 Total Referred: <b>${u.ref_count}</b>\n` +
    `💵 Total Earned: <b>${fmt(u.ref_earnings)}</b>\n\n` +
    `🔗 Your referral link:\n<code>${link}</code>`;
  await sendMessage(env, chatId, text, { reply_markup: referInlineKeyboard(link) });
}

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------

async function sendWithdrawPrompt(env: Env, chatId: number, userId: number) {
  const u = await getUser(env, userId);
  if (!u) return;
  const feePct = Number(env.WITHDRAW_FEE_PERCENT || "15");
  const minWithdraw = Number(env.MIN_WITHDRAW || "50");
  const available = Math.max(0, u.balance * (1 - feePct / 100));

  await setUserState(env, userId, "awaiting_withdraw_amount");

  const text =
    `৳ <b>Enter withdrawal amount</b>\n\n` +
    `- Balance: ${fmt(u.balance)}\n` +
    `- Fee: ${feePct}%\n` +
    `- Minimum withdrawal: ${fmt(minWithdraw)}\n` +
    `- Available for withdrawal: ${fmt(available)}`;
  await sendMessage(env, chatId, text, { reply_markup: backOnlyKeyboard() });
}

async function handleWithdrawAmount(env: Env, chatId: number, userId: number, text: string) {
  const amount = Number(text.replace(/[^\d.]/g, ""));
  const u = await getUser(env, userId);
  const feePct = Number(env.WITHDRAW_FEE_PERCENT || "15");
  const minWithdraw = Number(env.MIN_WITHDRAW || "50");

  if (!amount || amount <= 0) {
    return sendMessage(env, chatId, "Please enter a valid number.");
  }
  if (amount < minWithdraw) {
    return sendMessage(env, chatId, `Minimum withdrawal is ${fmt(minWithdraw)}.`);
  }
  if (amount > u.balance) {
    return sendMessage(env, chatId, `Insufficient balance. Your balance is ${fmt(u.balance)}.`);
  }

  await env.DB.prepare("UPDATE users SET state = ? WHERE id = ?")
    .bind(`awaiting_withdraw_wallet:${amount}`, userId)
    .run();

  await sendMessage(
    env,
    chatId,
    `📱 Send your <b>bKash/Nagad number</b> to receive ${fmt(amount * (1 - feePct / 100))} (after ${feePct}% fee):`,
    { reply_markup: backOnlyKeyboard() }
  );
}

async function handleWithdrawWallet(env: Env, chatId: number, userId: number, text: string) {
  const u = await getUser(env, userId);
  const [, amountStr] = (u.state as string).split(":");
  const amount = Number(amountStr);
  const feePct = Number(env.WITHDRAW_FEE_PERCENT || "15");
  const fee = Math.round(((amount * feePct) / 100) * 100) / 100;
  const payout = Math.round((amount - fee) * 100) / 100;
  const wallet = text.trim();

  if (!/^01\d{9}$/.test(wallet)) {
    return sendMessage(env, chatId, "That doesn't look like a valid 11-digit bKash/Nagad number. Try again:");
  }

  await createWithdrawal(env, userId, amount, fee, payout, "bkash/nagad", wallet);
  await setUserState(env, userId, null);

  await sendMessage(
    env,
    chatId,
    `✅ Withdrawal request submitted!\n\nAmount: ${fmt(amount)}\nFee: ${fmt(fee)}\nYou'll receive: ${fmt(
      payout
    )}\nWallet: <code>${wallet}</code>\n\nAn admin will process this shortly.`,
    { reply_markup: mainKeyboard(env, userId) }
  );

  const ids = (env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const adminId of ids) {
    await sendMessage(
      env,
      Number(adminId),
      `🔔 <b>New withdrawal request</b>\nUser: <code>${userId}</code>\nAmount: ${fmt(amount)}\nPayout: ${fmt(
        payout
      )}\nWallet: <code>${wallet}</code>\n\nReview it in the Admin Panel.`
    );
  }
}

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------

async function handleDepositAmount(env: Env, chatId: number, userId: number, text: string) {
  const amount = Number(text.replace(/[^\d.]/g, ""));
  if (!amount || amount <= 0) {
    return sendMessage(env, chatId, "Please enter a valid number.");
  }

  try {
    const { invoiceId, payUrl } = await createInvoice(env, { userId, amount });
    await recordDeposit(env, userId, amount, invoiceId);
    await setUserState(env, userId, null);
    await sendMessage(env, chatId, `💳 Deposit ${fmt(amount)} — tap below to pay via bKash/Nagad/Rocket/Upay.`, {
      reply_markup: depositPayKeyboard(payUrl),
    });
  } catch (e: any) {
    await sendMessage(env, chatId, `⚠️ Could not create a deposit right now: ${e.message}`);
  }
}

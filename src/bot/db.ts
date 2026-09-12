import type { Env } from "../env";
import type { TelegramWebAppUser } from "../utils/telegramAuth";

export interface TgFromUser {
  id: number;
  username?: string;
  first_name?: string;
}

export async function getOrCreateUser(env: Env, tg: TgFromUser, referredBy: number | null = null) {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(tg.id).first<any>();
  if (existing) return existing;

  await env.DB.prepare(
    `INSERT INTO users (id, username, first_name, referred_by) VALUES (?, ?, ?, ?)`
  )
    .bind(tg.id, tg.username || null, tg.first_name || null, referredBy)
    .run();

  if (referredBy) {
    await env.DB.prepare("UPDATE users SET ref_count = ref_count + 1 WHERE id = ?").bind(referredBy).run();
    await buildReferralChain(env, tg.id, referredBy);
  }

  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(tg.id).first<any>();
}

/** Populates referral_links for up to 3 ancestor levels above a freshly-referred user. */
async function buildReferralChain(env: Env, userId: number, directReferrer: number) {
  await env.DB.prepare("INSERT OR IGNORE INTO referral_links (user_id, ancestor_id, level) VALUES (?, ?, 1)")
    .bind(userId, directReferrer)
    .run();

  let current = directReferrer;
  for (let level = 2; level <= 3; level++) {
    const row = await env.DB.prepare("SELECT referred_by FROM users WHERE id = ?").bind(current).first<{
      referred_by: number | null;
    }>();
    if (!row?.referred_by) break;
    await env.DB.prepare("INSERT OR IGNORE INTO referral_links (user_id, ancestor_id, level) VALUES (?, ?, ?)")
      .bind(userId, row.referred_by, level)
      .run();
    current = row.referred_by;
  }
}

export async function getUser(env: Env, id: number) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<any>();
}

export async function setUserState(env: Env, id: number, state: string | null) {
  await env.DB.prepare("UPDATE users SET state = ? WHERE id = ?").bind(state, id).run();
}

export async function adjustBalance(env: Env, id: number, delta: number) {
  await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(delta, id).run();
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

export async function recordDeposit(env: Env, userId: number, amount: number, invoiceId: string) {
  await env.DB.prepare(
    `INSERT INTO deposits (user_id, amount, gateway, invoice_id, status) VALUES (?, ?, 'paylink', ?, 'pending')`
  )
    .bind(userId, amount, invoiceId)
    .run();
}

/** Credits a paid deposit exactly once (invoice_id is UNIQUE + status guard makes this idempotent). */
export async function markDepositPaid(env: Env, invoiceId: string, refBonusPercent: number) {
  const dep = await env.DB.prepare("SELECT * FROM deposits WHERE invoice_id = ?").bind(invoiceId).first<any>();
  if (!dep || dep.status === "paid") return null;

  await env.DB.prepare("UPDATE deposits SET status = 'paid', paid_at = datetime('now') WHERE id = ?")
    .bind(dep.id)
    .run();

  await env.DB.prepare(
    "UPDATE users SET balance = balance + ?, deposits_total = deposits_total + ? WHERE id = ?"
  )
    .bind(dep.amount, dep.amount, dep.user_id)
    .run();

  const user = await getUser(env, dep.user_id);
  if (user?.referred_by) {
    const bonus = Math.round(((dep.amount * refBonusPercent) / 100) * 100) / 100;
    if (bonus > 0) {
      await env.DB.prepare(
        "UPDATE users SET balance = balance + ?, ref_earnings = ref_earnings + ? WHERE id = ?"
      )
        .bind(bonus, bonus, user.referred_by)
        .run();
      await env.DB.prepare("INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, 'ref_bonus', ?, ?)")
        .bind(user.referred_by, bonus, JSON.stringify({ fromUser: dep.user_id, depositAmount: dep.amount }))
        .run();
    }
  }

  await env.DB.prepare("INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, 'deposit', ?, ?)")
    .bind(dep.user_id, dep.amount, JSON.stringify({ invoiceId }))
    .run();

  return dep;
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

export async function createWithdrawal(
  env: Env,
  userId: number,
  amount: number,
  fee: number,
  payout: number,
  method: string,
  wallet: string
) {
  const res = await env.DB.prepare(
    `INSERT INTO withdrawals (user_id, amount, fee, payout, method, wallet) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, amount, fee, payout, method, wallet)
    .run();
  await adjustBalance(env, userId, -amount);
  await env.DB.prepare("INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, 'withdraw', ?, ?)")
    .bind(userId, -amount, JSON.stringify({ method, wallet }))
    .run();
  return res.meta.last_row_id;
}

export async function resolveWithdrawal(env: Env, id: number, status: "approved" | "rejected" | "paid") {
  const wd = await env.DB.prepare("SELECT * FROM withdrawals WHERE id = ?").bind(id).first<any>();
  if (!wd) return null;
  await env.DB.prepare("UPDATE withdrawals SET status = ?, resolved_at = datetime('now') WHERE id = ?")
    .bind(status, id)
    .run();
  if (status === "approved" || status === "paid") {
    await env.DB.prepare("UPDATE users SET withdrawals_total = withdrawals_total + ? WHERE id = ?")
      .bind(wd.amount, wd.user_id)
      .run();
  } else if (status === "rejected") {
    await adjustBalance(env, wd.user_id, wd.amount); // refund
  }
  return wd;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function adminStats(env: Env) {
  const users = await env.DB.prepare("SELECT COUNT(*) c FROM users").first<{ c: number }>();
  const deposits = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) s FROM deposits WHERE status='paid'").first<{
    s: number;
  }>();
  const withdrawals = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE status IN ('approved','paid')"
  ).first<{ s: number }>();
  const pending = await env.DB.prepare(
    "SELECT w.*, u.username FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' ORDER BY w.created_at DESC LIMIT 50"
  ).all();
  return {
    totalUsers: users?.c ?? 0,
    totalDeposits: deposits?.s ?? 0,
    totalWithdrawals: withdrawals?.s ?? 0,
    pendingWithdrawals: pending.results,
  };
}

import type { Env } from "../env";
import { isAdmin } from "../api/auth";

/**
 * Main reply keyboard:
 *   row 1: Play Crash            (mini app)
 *   row 2: Profile | Refer & Earn
 *   row 3: Withdraw
 *   row 4: Admin Panel           (mini app, admins only)
 */
export function mainKeyboard(env: Env, userId: number) {
  const rows: any[][] = [
    [{ text: "🚀 Play Crash", web_app: { url: `${env.MINI_APP_BASE_URL}/index.html` } }],
    [{ text: "👤 Profile" }, { text: "👥 Refer & Earn" }],
    [{ text: "💸 Withdraw" }],
  ];
  if (isAdmin(env, userId)) {
    rows.push([{ text: "🛠 Admin Panel", web_app: { url: `${env.MINI_APP_BASE_URL}/admin.html` } }]);
  }
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

export function profileInlineKeyboard() {
  return {
    inline_keyboard: [[{ text: "💳 Deposit", callback_data: "deposit" }]],
  };
}

export function referInlineKeyboard(referLink: string) {
  return {
    inline_keyboard: [
      [
        { text: "📋 Copy Link", copy_text: { text: referLink } },
        { text: "📤 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${encodeURIComponent("Join LagahCrashBot and play Crash 🚀")}` },
      ],
      [{ text: "🔙 Back", callback_data: "back_to_menu" }],
    ],
  };
}

export function backOnlyKeyboard() {
  return { inline_keyboard: [[{ text: "🔙 Back", callback_data: "back_to_menu" }]] };
}

export function depositPayKeyboard(payUrl: string) {
  return { inline_keyboard: [[{ text: "💳 Pay Now", url: payUrl }]] };
}

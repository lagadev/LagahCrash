export interface Env {
  DB: D1Database;
  CRASH_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;

  // secrets (wrangler secret put ...)
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS: string; // comma separated telegram numeric ids
  MINI_APP_BASE_URL: string;
  PAYLINK_API_BASE: string;
  PAYLINK_API_KEY: string;

  // vars
  REF_BONUS_PERCENT: string;
  WITHDRAW_FEE_PERCENT: string;
  MIN_WITHDRAW: string;
  HOUSE_EDGE: string;
}

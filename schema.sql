-- Run with: wrangler d1 execute lagah-crash-bot-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY,        -- Telegram user id
  username           TEXT,
  first_name         TEXT,
  balance            REAL    NOT NULL DEFAULT 0, -- ৳ (BDT)
  total_wagered      REAL    NOT NULL DEFAULT 0,
  total_won          REAL    NOT NULL DEFAULT 0,
  referral_pending   REAL    NOT NULL DEFAULT 0, -- turnover-based ref earnings, credited on payout
  ref_count          INTEGER NOT NULL DEFAULT 0,
  ref_earnings       REAL    NOT NULL DEFAULT 0, -- deposit-bonus ref earnings actually paid out
  deposits_total     REAL    NOT NULL DEFAULT 0,
  withdrawals_total  REAL    NOT NULL DEFAULT 0,
  referred_by        INTEGER,                    -- direct referrer's Telegram id
  banned             INTEGER NOT NULL DEFAULT 0,
  state              TEXT,                       -- pending chat-flow state, e.g. 'awaiting_withdraw_amount'
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Flattened referral tree (up to 3 levels) so CrashRoom can credit turnover
-- bonuses without walking the chain on every bet.
CREATE TABLE IF NOT EXISTS referral_links (
  user_id      INTEGER NOT NULL,   -- the referred user
  ancestor_id  INTEGER NOT NULL,   -- who earns from user_id's activity
  level        INTEGER NOT NULL,   -- 1 = direct referrer, 2 = their referrer, ...
  PRIMARY KEY (user_id, ancestor_id)
);

CREATE TABLE IF NOT EXISTS deposits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  amount       REAL NOT NULL,
  gateway      TEXT NOT NULL DEFAULT 'paylink',
  invoice_id   TEXT UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at      TEXT
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  amount       REAL NOT NULL,
  fee          REAL NOT NULL,
  payout       REAL NOT NULL,
  method       TEXT,
  wallet       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | paid
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id             INTEGER PRIMARY KEY,
  crash_point    REAL NOT NULL,
  server_seed    TEXT NOT NULL,
  hash           TEXT NOT NULL,
  started_at     INTEGER NOT NULL,  -- unix seconds
  ended_at       INTEGER,
  total_bets     INTEGER NOT NULL DEFAULT 0,
  total_wagered  REAL NOT NULL DEFAULT 0,
  total_payout   REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id            INTEGER NOT NULL,
  user_id             INTEGER NOT NULL,
  amount              REAL NOT NULL,
  auto_cashout_at     REAL,
  cashout_multiplier  REAL,
  win_amount          REAL NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,             -- placed | won | lost
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,                      -- bet | win | deposit | withdraw | ref_bonus
  amount     REAL NOT NULL,                       -- signed
  meta       TEXT,                                -- JSON blob
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row table holding the admin's "force next round's crash point" override.
CREATE TABLE IF NOT EXISTS game_control (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  forced_crash_point  REAL
);
INSERT OR IGNORE INTO game_control (id, forced_crash_point) VALUES (1, NULL);

-- Freeform key/value settings (game tuning thresholds, refer %, withdraw fee, etc).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round_id);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_ancestor ON referral_links(ancestor_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);

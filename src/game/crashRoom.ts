import type { Env } from "../env";
import {
  addBet,
  applyGameTuning,
  cashoutBet,
  freshRound,
  publicRoundView,
  settleLosers,
  tickRound,
  CRASHED_MS,
  MIN_BET,
  TICK_RUNNING_MS,
  TICK_WAITING_MS,
  WAITING_MS,
  HISTORY_LIMIT,
  type GameTuning,
} from "./engine";
import { deriveCrashPoint, generateServerSeed } from "./multiplier";
import type { PlayerBet, RoundState } from "./types";

interface Session {
  ws: WebSocket;
  userId: number;
  username: string;
  photoUrl?: string;
}

// Referral payout rates applied to *turnover* (the wagered amount), per level.
const REFERRAL_TURNOVER_RATES = [0.005, 0.002, 0.001]; // level 1, 2, 3

export class CrashRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Session[] = [];
  private round: RoundState;
  private crashPoint = 1.0; // finalized once betting closes (see resolveCrashPoint)
  private baseCrashPoint = 1.0; // provably-fair draw, before "gamer logic" tuning
  private forcedCrashPoint: number | null = null; // admin override for this round, if any
  private serverSeed = "";
  private loopRunning = false;
  private roundIdCounter = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.round = freshRound(1, "");
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<number>("roundIdCounter");
      this.roundIdCounter = stored ?? 0;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      const userId = Number(request.headers.get("X-User-Id"));
      const username = request.headers.get("X-Username") || "player";
      const photoUrl = request.headers.get("X-Photo-Url") || undefined;
      if (!userId) return new Response("unauthorized", { status: 401 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const session: Session = { ws: server, userId, username, photoUrl };
      this.sessions.push(session);

      server.send(JSON.stringify({ type: "state", payload: publicRoundView(this.round) }));

      server.addEventListener("message", (evt) => this.handleMessage(session, evt.data as string));
      server.addEventListener("close", () => {
        this.sessions = this.sessions.filter((s) => s !== session);
      });

      this.ensureLoopRunning();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/state")) {
      return new Response(JSON.stringify(publicRoundView(this.round)), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  private broadcast(msg: unknown) {
    const payload = JSON.stringify(msg);
    this.sessions = this.sessions.filter((s) => {
      try {
        s.ws.send(payload);
        return true;
      } catch {
        return false;
      }
    });
  }

  private async handleMessage(session: Session, raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "bet") {
      await this.placeBet(session, Number(msg.amount), msg.autoCashoutAt ? Number(msg.autoCashoutAt) : null);
    } else if (msg.type === "cashout") {
      await this.doCashout(session);
    }
  }

  private async placeBet(session: Session, amount: number, autoCashoutAt: number | null) {
    if (!Number.isInteger(amount) || amount < MIN_BET) {
      session.ws.send(JSON.stringify({ type: "error", payload: `Minimum bet is ${MIN_BET} \u09f3` }));
      return;
    }
    if (this.round.phase !== "waiting") {
      session.ws.send(JSON.stringify({ type: "error", payload: "Betting is closed for this round" }));
      return;
    }

    const userRow = await this.env.DB.prepare(`SELECT banned FROM users WHERE id = ?`).bind(session.userId).first<{
      banned: number;
    }>();
    if (userRow?.banned) {
      session.ws.send(JSON.stringify({ type: "error", payload: "Your account is suspended" }));
      return;
    }

    // Atomically debit the user's balance (fails if insufficient funds).
    const res = await this.env.DB.prepare(
      `UPDATE users SET balance = balance - ?, total_wagered = total_wagered + ?
       WHERE id = ? AND balance >= ?`
    )
      .bind(amount, amount, session.userId, amount)
      .run();

    if (!res.meta.changes) {
      session.ws.send(JSON.stringify({ type: "error", payload: "Insufficient balance" }));
      return;
    }

    const bet: PlayerBet = {
      userId: session.userId,
      username: session.username,
      photoUrl: session.photoUrl,
      amount,
      autoCashoutAt,
      cashedOutAt: null,
      status: "placed",
    };

    if (!addBet(this.round, bet)) {
      // refund, shouldn't normally happen
      await this.env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`)
        .bind(amount, session.userId)
        .run();
      session.ws.send(JSON.stringify({ type: "error", payload: "Could not place bet" }));
      return;
    }

    await this.env.DB.prepare(
      `INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, 'bet', ?, ?)`
    )
      .bind(session.userId, -amount, JSON.stringify({ roundId: this.round.roundId }))
      .run();

    await this.accrueReferralTurnover(session.userId, amount);

    session.ws.send(JSON.stringify({ type: "balance", payload: await this.getBalance(session.userId) }));
    this.broadcast({ type: "state", payload: publicRoundView(this.round) });
  }

  private async doCashout(session: Session) {
    const bet = cashoutBet(this.round, session.userId, this.round.multiplier);
    if (!bet) {
      session.ws.send(JSON.stringify({ type: "error", payload: "Nothing to cash out" }));
      return;
    }
    const winAmount = Math.floor(bet.amount * bet.cashedOutAt!);
    await this.env.DB.prepare(
      `UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE id = ?`
    )
      .bind(winAmount, winAmount, session.userId)
      .run();
    await this.env.DB.prepare(
      `INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, 'win', ?, ?)`
    )
      .bind(session.userId, winAmount, JSON.stringify({ roundId: this.round.roundId, multiplier: bet.cashedOutAt }))
      .run();

    session.ws.send(JSON.stringify({ type: "balance", payload: await this.getBalance(session.userId) }));
    this.broadcast({ type: "cashed_out", payload: { userId: session.userId, multiplier: bet.cashedOutAt } });
    this.broadcast({ type: "state", payload: publicRoundView(this.round) });
  }

  private async getBalance(userId: number): Promise<number> {
    const row = await this.env.DB.prepare(`SELECT balance FROM users WHERE id = ?`).bind(userId).first<{
      balance: number;
    }>();
    return row?.balance ?? 0;
  }

  /** Credits pending (not-yet-payable) referral turnover to up to 3 ancestor levels. */
  private async accrueReferralTurnover(userId: number, wageredAmount: number) {
    const links = await this.env.DB.prepare(
      `SELECT ancestor_id, level FROM referral_links WHERE user_id = ? ORDER BY level ASC`
    )
      .bind(userId)
      .all<{ ancestor_id: number; level: number }>();

    for (const link of links.results ?? []) {
      const rate = REFERRAL_TURNOVER_RATES[link.level - 1];
      if (!rate) continue;
      const cents = wageredAmount * rate;
      if (cents < 0.01) continue;
      await this.env.DB.prepare(`UPDATE users SET referral_pending = referral_pending + ? WHERE id = ?`)
        .bind(cents, link.ancestor_id)
        .run();
    }
  }

  private ensureLoopRunning() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.runLoop().catch((e) => {
      console.error("CrashRoom loop crashed", e);
      this.loopRunning = false;
    });
  }

  private async runLoop() {
    // Auto-stop the tick loop once nobody is connected, to save compute.
    while (this.sessions.length > 0 || this.round.phase !== "waiting") {
      await this.step();
      const delay = this.round.phase === "running" ? TICK_RUNNING_MS : TICK_WAITING_MS;
      await new Promise((r) => setTimeout(r, delay));
      if (this.sessions.length === 0 && this.round.phase === "waiting" && this.round.countdownMs === WAITING_MS) {
        break; // idle - nobody watching an unstarted round
      }
    }
    this.loopRunning = false;
  }

  private async step() {
    const now = Date.now();

    if (this.round.startedAt === 0) {
      // First ever tick: kick off round #1's betting window.
      await this.beginRound(now);
      return;
    }

    tickRound(this.round, now, this.crashPoint);

    if (this.round.phase === "waiting") {
      // Broadcast the live countdown every tick.
      this.broadcast({ type: "countdown", payload: { countdownSeconds: Math.ceil(this.round.countdownMs / 1000) } });

      if (this.round.countdownMs <= 0) {
        await this.resolveCrashPoint();
        this.round.phase = "running";
        this.round.startedAt = now;
        this.broadcast({ type: "round_start", payload: publicRoundView(this.round) });
      }
      return;
    }

    if (this.round.phase === "running") {
      // Handle auto-cashouts
      for (const b of this.round.bets) {
        if (b.status === "placed" && b.autoCashoutAt && this.round.multiplier >= b.autoCashoutAt) {
          cashoutBet(this.round, b.userId, b.autoCashoutAt);
          const winAmount = Math.floor(b.amount * b.autoCashoutAt);
          this.env.DB.prepare(
            `UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE id = ?`
          )
            .bind(winAmount, winAmount, b.userId)
            .run()
            .catch(() => {});
          this.broadcast({ type: "cashed_out", payload: { userId: b.userId, multiplier: b.autoCashoutAt } });
        }
      }
      this.broadcast({ type: "tick", payload: { multiplier: this.round.multiplier } });
      return;
    }

    if (this.round.phase === "crashed" && this.round.crashPoint !== null) {
      await this.finishRound(now);
    }
  }

  /** Reads the last N *completed* rounds straight from D1, so history survives Durable Object eviction/restarts. */
  private async loadHistoryFromD1(): Promise<number[]> {
    const rows = await this.env.DB.prepare(
      `SELECT crash_point FROM rounds WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?`
    )
      .bind(HISTORY_LIMIT)
      .all<{ crash_point: number }>();
    return (rows.results ?? []).map((r) => r.crash_point);
  }

  private async beginRound(now: number) {
    this.roundIdCounter += 1;
    await this.state.storage.put("roundIdCounter", this.roundIdCounter);

    this.serverSeed = generateServerSeed();
    const { crashPoint, hash } = await deriveCrashPoint(
      this.serverSeed,
      this.roundIdCounter,
      Number(this.env.HOUSE_EDGE || "0.03")
    );
    this.baseCrashPoint = crashPoint;
    this.crashPoint = crashPoint; // provisional; finalized in resolveCrashPoint() once betting closes

    // Admin override: force this round to crash at a specific multiplier.
    const control = await this.env.DB.prepare(
      `SELECT forced_crash_point FROM game_control WHERE id = 1`
    ).first<{ forced_crash_point: number | null }>();
    this.forcedCrashPoint = control?.forced_crash_point ?? null;
    if (this.forcedCrashPoint !== null) {
      await this.env.DB.prepare(`UPDATE game_control SET forced_crash_point = NULL WHERE id = 1`).run();
    }

    const history = await this.loadHistoryFromD1();
    this.round = freshRound(this.roundIdCounter, hash);
    this.round.history = history;
    this.round.startedAt = now;

    await this.env.DB.prepare(
      `INSERT INTO rounds (id, crash_point, server_seed, hash, started_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(this.roundIdCounter, this.crashPoint, this.serverSeed, hash, Math.floor(now / 1000))
      .run()
      .catch(() => {});

    this.broadcast({ type: "state", payload: publicRoundView(this.round) });
  }

  /**
   * Called the instant betting closes. Applies the admin's forced override
   * if set, otherwise runs the "gamer logic" tuning (lots of players ->
   * longer round; one big bet -> fast crash) on top of the provably-fair
   * base draw, then persists the final number.
   */
  private async resolveCrashPoint() {
    if (this.forcedCrashPoint !== null) {
      this.crashPoint = this.forcedCrashPoint;
    } else {
      const tuning = await this.loadGameTuning();
      this.crashPoint = applyGameTuning(this.baseCrashPoint, this.round.bets, tuning);
    }
    await this.env.DB.prepare(`UPDATE rounds SET crash_point = ? WHERE id = ?`)
      .bind(this.crashPoint, this.round.roundId)
      .run()
      .catch(() => {});
  }

  private async loadGameTuning(): Promise<GameTuning> {
    const row = await this.env.DB.prepare(`SELECT value FROM settings WHERE key = 'game_tuning'`).first<{
      value: string;
    }>();
    const defaults: GameTuning = {
      bigBetThreshold: 2000,
      bigBetMaxCrash: 1.5,
      multiplayerThreshold: 5,
      multiplayerMinCrash: 3,
    };
    if (!row?.value) return defaults;
    try {
      return { ...defaults, ...JSON.parse(row.value) };
    } catch {
      return defaults;
    }
  }

  private async finishRound(now: number) {
    settleLosers(this.round);

    const totalWagered = this.round.bets.reduce((s, b) => s + b.amount, 0);
    const totalPayout = this.round.bets
      .filter((b) => b.status === "won")
      .reduce((s, b) => s + Math.floor(b.amount * (b.cashedOutAt ?? 1)), 0);

    await this.env.DB.prepare(
      `UPDATE rounds SET ended_at = ?, total_bets = ?, total_wagered = ?, total_payout = ? WHERE id = ?`
    )
      .bind(Math.floor(now / 1000), this.round.bets.length, totalWagered, totalPayout, this.round.roundId)
      .run()
      .catch(() => {});

    for (const b of this.round.bets) {
      await this.env.DB.prepare(
        `INSERT INTO bets (round_id, user_id, amount, auto_cashout_at, cashout_multiplier, win_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          this.round.roundId,
          b.userId,
          b.amount,
          b.autoCashoutAt,
          b.cashedOutAt,
          b.status === "won" ? Math.floor(b.amount * (b.cashedOutAt ?? 1)) : 0,
          b.status
        )
        .run()
        .catch(() => {});
    }

    // Immediate optimistic history update.
    this.round.history = [this.round.crashPoint ?? this.crashPoint, ...this.round.history].slice(0, HISTORY_LIMIT);
    this.broadcast({ type: "crash", payload: publicRoundView(this.round) });

    // Hold on the crashed frame for CRASHED_MS so clients can show the crash animation.
    await new Promise((r) => setTimeout(r, CRASHED_MS));
    await this.beginRound(Date.now());
  }
}

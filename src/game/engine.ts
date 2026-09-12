import { multiplierAtElapsed } from "./multiplier";
import type { PlayerBet, RoundPhase, RoundState } from "./types";

export const WAITING_MS = 5_000; // betting window
export const CRASHED_MS = 3_500; // how long the crashed frame stays up before the next round
export const TICK_RUNNING_MS = 100;
export const TICK_WAITING_MS = 250;
export const HISTORY_LIMIT = 10; // keep the last 10 rounds
export const MIN_BET = 1; // minimum bet, in BDT

export function freshRound(roundId: number, serverHash: string): RoundState {
  return {
    roundId,
    phase: "waiting",
    multiplier: 1.0,
    crashPoint: null,
    countdownMs: WAITING_MS,
    startedAt: 0,
    history: [],
    bets: [],
    serverHash,
  };
}

/** Advances the round's derived fields (multiplier / countdown) given the current time. Mutates & returns state. */
export function tickRound(state: RoundState, now: number, crashPoint: number): RoundState {
  if (state.phase === "waiting") {
    const elapsed = now - state.startedAt;
    state.countdownMs = Math.max(0, WAITING_MS - elapsed);
  } else if (state.phase === "running") {
    const elapsed = now - state.startedAt;
    state.multiplier = multiplierAtElapsed(elapsed);
    if (state.multiplier >= crashPoint) {
      state.multiplier = crashPoint;
      state.phase = "crashed";
      state.crashPoint = crashPoint;
    }
  }
  return state;
}

export function addBet(state: RoundState, bet: PlayerBet): boolean {
  if (state.phase !== "waiting") return false;
  if (state.bets.some((b) => b.userId === bet.userId)) return false;
  state.bets.push(bet);
  return true;
}

export function cashoutBet(state: RoundState, userId: number, multiplier: number): PlayerBet | null {
  if (state.phase !== "running") return null;
  const bet = state.bets.find((b) => b.userId === userId && b.status === "placed");
  if (!bet) return null;
  bet.status = "won";
  bet.cashedOutAt = multiplier;
  return bet;
}

export function settleLosers(state: RoundState): PlayerBet[] {
  const losers = state.bets.filter((b) => b.status === "placed");
  for (const b of losers) b.status = "lost";
  return losers;
}

export function pushHistory(history: number[], crashPoint: number): number[] {
  return [crashPoint, ...history].slice(0, HISTORY_LIMIT);
}

export function publicRoundView(state: RoundState) {
  return {
    roundId: state.roundId,
    phase: state.phase as RoundPhase,
    multiplier: state.multiplier,
    countdownSeconds: Math.ceil(state.countdownMs / 1000),
    history: state.history,
    serverHash: state.serverHash,
    crashPoint: state.phase === "crashed" ? state.crashPoint : null,
    bets: state.bets.map((b) => {
      const activeMultiplier = b.cashedOutAt ?? (state.phase === "running" ? state.multiplier : 1.0);
      return {
        userId: b.userId,
        username: b.username,
        photoUrl: b.photoUrl,
        amount: b.amount,
        multiplier: activeMultiplier,
        // Live "winnings so far" the UI grows in place of a static prize icon.
        winningsNow: Math.floor(b.amount * activeMultiplier),
        status: b.status,
      };
    }),
  };
}

export interface GameTuning {
  bigBetThreshold: number; // a single bet >= this instantly biases toward a fast crash
  bigBetMaxCrash: number; // ceiling for that fast crash (e.g. 1.5x)
  multiplayerThreshold: number; // this many players or more biases toward a longer round
  multiplayerMinCrash: number; // floor multiplier used as the base of that boost
}

/**
 * "Gamer logic": nudges the provably-fair base crash point using the
 * current round's bets:
 *  - a lot of players queued up together -> the round tends to run longer
 *  - any single very large bet -> the round tends to crash fast
 * A small random component is kept either way so results still aren't
 * perfectly predictable round to round.
 */
export function applyGameTuning(baseCrashPoint: number, bets: PlayerBet[], tuning: GameTuning): number {
  const maxBet = bets.reduce((m, b) => Math.max(m, b.amount), 0);
  if (maxBet >= tuning.bigBetThreshold) {
    const ceiling = Math.max(1.01, tuning.bigBetMaxCrash);
    return Math.round((1 + Math.random() * (ceiling - 1)) * 100) / 100;
  }
  if (bets.length >= tuning.multiplayerThreshold) {
    const boosted = tuning.multiplayerMinCrash + Math.random() * tuning.multiplayerMinCrash;
    return Math.round(Math.max(baseCrashPoint, boosted) * 100) / 100;
  }
  return baseCrashPoint;
}

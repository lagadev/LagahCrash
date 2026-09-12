export type RoundPhase = "waiting" | "running" | "crashed";

export interface PlayerBet {
  userId: number;
  username: string;
  photoUrl?: string;
  amount: number;
  autoCashoutAt: number | null;
  cashedOutAt: number | null; // multiplier at which they cashed out, null = still in / lost
  status: "placed" | "won" | "lost";
}

export interface RoundState {
  roundId: number;
  phase: RoundPhase;
  multiplier: number;
  crashPoint: number | null; // hidden from clients until the round crashes
  countdownMs: number; // ms left of the betting window (phase = waiting)
  startedAt: number; // epoch ms the "running" phase started
  history: number[]; // last N crash points, most recent first
  bets: PlayerBet[];
  serverHash: string; // provably-fair commitment, shown up-front
}

export interface ClientMessage {
  type: "bet" | "cashout" | "cancel_bet";
  amount?: number;
  autoCashoutAt?: number | null;
}

export interface ServerMessage {
  type:
    | "state"
    | "round_start"
    | "tick"
    | "crash"
    | "bet_placed"
    | "cashed_out"
    | "error"
    | "balance"
    | "countdown";
  payload: any;
}

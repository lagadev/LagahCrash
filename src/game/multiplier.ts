// Provably-fair crash point generation (Bustabit-style) + the live growth curve.

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generates a fresh random server seed for one round. */
export function generateServerSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derives the crash point for a round from its server seed.
 * The published `hash` (sha256 of the seed) lets players verify fairness
 * after the fact by re-hashing the revealed seed.
 */
export async function deriveCrashPoint(
  serverSeed: string,
  roundId: number,
  houseEdge = 0.03
): Promise<{ crashPoint: number; hash: string }> {
  const hash = await sha256Hex(`${serverSeed}:${roundId}`);
  const h = hash.slice(0, 13); // 52 bits of entropy
  const intVal = parseInt(h, 16);
  const maxVal = Math.pow(2, 52);

  // Roughly `houseEdge` fraction of rounds instantly crash at 1.00x.
  const edgeDivisor = Math.max(2, Math.floor(1 / houseEdge));
  if (intVal % edgeDivisor === 0) {
    return { crashPoint: 1.0, hash };
  }

  const raw = (100 * maxVal - intVal) / (maxVal - intVal) / 100;
  const crashPoint = Math.max(1.0, Math.floor(raw * 100) / 100);
  return { crashPoint: Math.min(crashPoint, 1000), hash };
}

/** Smooth exponential growth curve used to animate the multiplier while a round is running. */
export function multiplierAtElapsed(elapsedMs: number): number {
  const t = elapsedMs / 1000;
  const m = Math.exp(0.06 * t);
  return Math.max(1.0, Math.round(m * 100) / 100);
}

/** Inverse of multiplierAtElapsed - how many ms until a given multiplier is reached. */
export function elapsedForMultiplier(multiplier: number): number {
  const t = Math.log(multiplier) / 0.06;
  return Math.max(0, t * 1000);
}

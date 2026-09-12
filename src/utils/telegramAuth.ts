// Validates the `initData` string a Telegram Mini App sends with every
// request: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// This stops anyone from calling /api/game/* or /api/admin/* with a forged
// user id.

async function hmacSha256(keyBytes: BufferSource, msgBytes: BufferSource): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msgBytes));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TelegramWebAppUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
}

export async function validateInitData(initData: string, botToken: string): Promise<TelegramWebAppUser | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const enc = new TextEncoder();
  const secretKey = await hmacSha256(enc.encode("WebAppData"), enc.encode(botToken));
  const computedHash = toHex(await hmacSha256(secretKey, enc.encode(dataCheckString)));

  if (computedHash !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (Date.now() / 1000 - authDate > 86400) return null; // stale > 24h

  const userJson = params.get("user");
  return userJson ? JSON.parse(userJson) : null;
}

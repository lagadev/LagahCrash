// ---------------------------------------------------------------------------
// PayLink (https://uglypay.devugly.workers.dev) — bKash / Nagad / Rocket / Upay
//
//   POST /api/invoices   { amount, reference, callbackUrl }  -> { payUrl, ... }
//   webhook: POST <callbackUrl>, header "x-signature" = HMAC-SHA256(rawBody, PAYLINK_API_KEY)
//            body: { event, reference, amount, netAmount, trxId }
//            event === "invoice.verified" means the payment is confirmed.
//
// `reference` is our own deposit invoice id (see createInvoice below); PayLink
// echoes it back on the webhook so we know which deposit/user to credit.
// `amount` is what the customer paid — that's what gets credited to the
// user's game balance. `netAmount` (amount minus PayLink's own processing
// fee) is what you actually receive as the merchant; it's not used here.
// ---------------------------------------------------------------------------

import type { Env } from "../env";

export interface CreateInvoiceResult {
  invoiceId: string;
  payUrl: string;
}

export async function createInvoice(
  env: Env,
  { userId, amount }: { userId: number; amount: number }
): Promise<CreateInvoiceResult> {
  if (!env.PAYLINK_API_BASE || !env.PAYLINK_API_KEY) {
    throw new Error("Payment gateway not configured — set PAYLINK_API_BASE / PAYLINK_API_KEY.");
  }

  const reference = `dep_${userId}_${Date.now()}`;

  const res = await fetch(`${env.PAYLINK_API_BASE}/api/invoices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.PAYLINK_API_KEY}`,
    },
    body: JSON.stringify({
      amount,
      reference,
      callbackUrl: `${env.MINI_APP_BASE_URL}/api/deposit/webhook`,
    }),
  });

  if (!res.ok) {
    throw new Error(`PayLink error: ${res.status} ${await res.text()}`);
  }

  const invoice: any = await res.json();
  if (!invoice.payUrl) {
    throw new Error("PayLink response did not include a payUrl.");
  }

  return { invoiceId: reference, payUrl: invoice.payUrl };
}

export interface VerifiedWebhook {
  invoiceId: string; // our `reference`
  amount: number; // what the customer paid — credit this to the balance
  trxId?: string;
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies a PayLink webhook call and returns the paid invoice, or null if
 * the signature is missing/invalid or the event isn't a confirmed payment.
 * Signs the *raw* request body exactly as received (must match byte-for-byte
 * what PayLink signed on their side) with our own PAYLINK_API_KEY — never
 * trust this without the signature check.
 */
export async function verifyWebhook(env: Env, request: Request): Promise<VerifiedWebhook | null> {
  const signature = request.headers.get("x-signature");
  if (!signature) return null;

  const rawBody = await request.text();
  const expected = await hmacSha256Hex(env.PAYLINK_API_KEY, rawBody);
  if (signature !== expected) return null;

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (body.event !== "invoice.verified") return null;
  if (!body.reference || typeof body.amount !== "number") return null;

  return { invoiceId: body.reference, amount: body.amount, trxId: body.trxId };
}
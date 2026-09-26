/**
 * Safaricom Daraja (M-Pesa) client — server only.
 *
 * Credentials are stored per tenant in `mpesa_settings` and never leave the
 * server. Every call returns a plain result object so callers can record the
 * provider's own status text instead of guessing.
 */

export type MpesaCredentials = {
  organizationId: string;
  environment: "sandbox" | "production";
  shortCode: string;
  partyB: string;
  transactionType: string;
  accountReference: string | null;
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  callbackToken: string;
  callbackBaseUrl: string | null;
  enabled: boolean;
};

export type DarajaResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: string; detail: string };

const HOSTS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
} as const;

export function darajaHost(environment: string): string {
  return environment === "production" ? HOSTS.production : HOSTS.sandbox;
}

/** Daraja expects 2547XXXXXXXX — normalise anything a cashier might type. */
export function normaliseMsisdn(raw: string): string | null {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  if (digits.startsWith("254")) return digits;
  return null;
}

export function darajaTimestamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    String(now.getUTCFullYear()) +
    p(now.getUTCMonth() + 1) +
    p(now.getUTCDate()) +
    p(now.getUTCHours()) +
    p(now.getUTCMinutes()) +
    p(now.getUTCSeconds())
  );
}

export function stkPassword(shortCode: string, passkey: string, timestamp: string): string {
  return btoa(`${shortCode}${passkey}${timestamp}`);
}

/** Loads tenant credentials with the trusted client; secrets stay server-side. */
export async function loadMpesaCredentials(organizationId: string): Promise<MpesaCredentials | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("mpesa_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const shortCode = String(row["short_code"] ?? "").trim();
  const consumerKey = String(row["consumer_key"] ?? "").trim();
  const consumerSecret = String(row["consumer_secret"] ?? "").trim();
  const passkey = String(row["passkey"] ?? "").trim();
  if (!shortCode || !consumerKey || !consumerSecret || !passkey) return null;
  return {
    organizationId,
    environment: String(row["environment"] ?? "sandbox") === "production" ? "production" : "sandbox",
    shortCode,
    partyB: String(row["party_b"] ?? "").trim() || shortCode,
    transactionType: String(row["transaction_type"] ?? "CustomerPayBillOnline"),
    accountReference: (row["account_reference"] as string | null) ?? null,
    consumerKey,
    consumerSecret,
    passkey,
    callbackToken: String(row["callback_token"] ?? ""),
    callbackBaseUrl: (row["callback_base_url"] as string | null) ?? null,
    enabled: Boolean(row["enabled"]),
  };
}

export async function darajaToken(creds: MpesaCredentials): Promise<DarajaResult<string>> {
  const auth = btoa(`${creds.consumerKey}:${creds.consumerSecret}`);
  try {
    const res = await fetch(`${darajaHost(creds.environment)}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: `http-${res.status}`, detail: text.slice(0, 400) };
    const parsed = JSON.parse(text) as { access_token?: string };
    if (!parsed.access_token) return { ok: false, status: "no-token", detail: text.slice(0, 400) };
    return { ok: true, data: parsed.access_token };
  } catch (error) {
    return { ok: false, status: "network", detail: (error as Error).message };
  }
}

export type StkPushResult = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  CustomerMessage?: string;
  errorCode?: string;
  errorMessage?: string;
};

export async function stkPush(
  creds: MpesaCredentials,
  input: { msisdn: string; amount: number; accountReference: string; description: string; callbackUrl: string },
): Promise<DarajaResult<StkPushResult & { request: Record<string, unknown> }>> {
  const tokenResult = await darajaToken(creds);
  if (!tokenResult.ok) return tokenResult;

  const timestamp = darajaTimestamp();
  const body = {
    BusinessShortCode: creds.shortCode,
    Password: stkPassword(creds.shortCode, creds.passkey, timestamp),
    Timestamp: timestamp,
    TransactionType: creds.transactionType,
    Amount: Math.max(1, Math.round(input.amount)),
    PartyA: input.msisdn,
    PartyB: creds.partyB,
    PhoneNumber: input.msisdn,
    CallBackURL: input.callbackUrl,
    AccountReference: input.accountReference.slice(0, 12) || "NEO",
    TransactionDesc: input.description.slice(0, 60) || "Payment",
  };

  try {
    const res = await fetch(`${darajaHost(creds.environment)}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenResult.data}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: StkPushResult = {};
    try {
      parsed = JSON.parse(text) as StkPushResult;
    } catch {
      return { ok: false, status: `http-${res.status}`, detail: text.slice(0, 400) };
    }
    if (!res.ok || parsed.ResponseCode !== "0") {
      return {
        ok: false,
        status: `http-${res.status}`,
        detail: parsed.errorMessage ?? parsed.ResponseDescription ?? text.slice(0, 400),
      };
    }
    const safeRequest = { ...body, Password: "[redacted]" } as Record<string, unknown>;
    return { ok: true, data: { ...parsed, request: safeRequest } };
  } catch (error) {
    return { ok: false, status: "network", detail: (error as Error).message };
  }
}

export type StkQueryResult = {
  ResultCode?: string;
  ResultDesc?: string;
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  errorCode?: string;
  errorMessage?: string;
};

export async function stkQuery(
  creds: MpesaCredentials,
  checkoutRequestId: string,
): Promise<DarajaResult<StkQueryResult>> {
  const tokenResult = await darajaToken(creds);
  if (!tokenResult.ok) return tokenResult;

  const timestamp = darajaTimestamp();
  try {
    const res = await fetch(`${darajaHost(creds.environment)}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenResult.data}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: creds.shortCode,
        Password: stkPassword(creds.shortCode, creds.passkey, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
    });
    const text = await res.text();
    let parsed: StkQueryResult = {};
    try {
      parsed = JSON.parse(text) as StkQueryResult;
    } catch {
      return { ok: false, status: `http-${res.status}`, detail: text.slice(0, 400) };
    }
    if (!res.ok && !parsed.ResultCode) {
      return { ok: false, status: `http-${res.status}`, detail: parsed.errorMessage ?? text.slice(0, 400) };
    }
    return { ok: true, data: parsed };
  } catch (error) {
    return { ok: false, status: "network", detail: (error as Error).message };
  }
}

/** Extracts the fields NEØ stores from an STK callback body. */
export function readStkCallback(payload: unknown): {
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
  resultCode: number | null;
  resultDesc: string;
  receipt: string | null;
  transactionDate: string | null;
  amount: number | null;
} {
  const root = (payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cb = root["Body"]?.["stkCallback"] ?? root["stkCallback"] ?? root;
  const items: Array<{ Name?: string; Value?: unknown }> = cb?.["CallbackMetadata"]?.["Item"] ?? [];
  const pick = (name: string) => items.find((i) => i?.Name === name)?.Value ?? null;
  const receipt = pick("MpesaReceiptNumber");
  const txnDate = pick("TransactionDate");
  const amount = pick("Amount");
  const code = cb?.["ResultCode"];
  return {
    checkoutRequestId: cb?.["CheckoutRequestID"] ? String(cb["CheckoutRequestID"]) : null,
    merchantRequestId: cb?.["MerchantRequestID"] ? String(cb["MerchantRequestID"]) : null,
    resultCode: code === null || code === undefined ? null : Number(code),
    resultDesc: String(cb?.["ResultDesc"] ?? ""),
    receipt: receipt ? String(receipt) : null,
    transactionDate: txnDate ? String(txnDate) : null,
    amount: amount === null || amount === undefined ? null : Number(amount),
  };
}

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

export type DarajaResult<T> = { ok: true; data: T } | { ok: false; status: string; detail: string };

const HOSTS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
} as const;

export function darajaHost(environment: string): string {
  return environment === "production" ? HOSTS.production : HOSTS.sandbox;
}

/** Missing/empty provider results must never become success through Number(null). */
export function darajaResultCode(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const code = Number(value);
  return Number.isSafeInteger(code) && code >= 0 ? code : null;
}

/** Daraja expects 2547XXXXXXXX — normalise anything a cashier might type. */
export function normaliseMsisdn(raw: string): string | null {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
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

/** Zero-row gateway check before guest routines can reserve a payable balance. */
export async function verifyMpesaServerAccess(): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("mpesa_settings").select("organization_id").limit(0);
  if (error) {
    throw new Error(
      /invalid api key/i.test(error.message)
        ? "The app's Supabase server key is invalid. No guest payment was started or prompt sent."
        : "The payment server connection could not be verified. No guest payment was started or prompt sent.",
    );
  }
}

/** Loads tenant credentials with the trusted client; secrets stay server-side. */
export async function loadMpesaCredentials(
  organizationId: string,
): Promise<MpesaCredentials | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("mpesa_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    if (/invalid api key/i.test(error.message)) {
      throw new Error(
        "Privileged M-Pesa execution is unavailable on this host. The Lovable-managed payment backend must execute saved-credential operations; do not retrieve its managed service-role key or retry a payment to repair this connection.",
      );
    }
    throw new Error(error.message);
  }
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const shortCode = String(row["short_code"] ?? "").trim();
  const consumerKey = String(row["consumer_key"] ?? "").trim();
  const consumerSecret = String(row["consumer_secret"] ?? "").trim();
  const passkey = String(row["passkey"] ?? "").trim();
  if (!shortCode || !consumerKey || !consumerSecret || !passkey) return null;
  return {
    organizationId,
    environment:
      String(row["environment"] ?? "sandbox") === "production" ? "production" : "sandbox",
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

export async function darajaToken(
  creds: Pick<MpesaCredentials, "environment" | "consumerKey" | "consumerSecret">,
): Promise<DarajaResult<string>> {
  const auth = btoa(`${creds.consumerKey}:${creds.consumerSecret}`);
  try {
    const res = await fetch(
      `${darajaHost(creds.environment)}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    const text = await res.text();
    if (!res.ok)
      return {
        ok: false,
        status: `http-${res.status}`,
        detail: `Safaricom rejected the authentication request (HTTP ${res.status}).`,
      };
    let parsed: { access_token?: string };
    try {
      parsed = JSON.parse(text) as { access_token?: string };
    } catch {
      return {
        ok: false,
        status: "invalid-response",
        detail: "Safaricom returned an unreadable authentication response.",
      };
    }
    if (!parsed.access_token)
      return { ok: false, status: "no-token", detail: "Safaricom did not issue an access token." };
    return { ok: true, data: parsed.access_token };
  } catch {
    return {
      ok: false,
      status: "network",
      detail: "Safaricom could not be reached. Check the connection and try again.",
    };
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
  input: {
    msisdn: string;
    amount: number;
    accountReference: string;
    description: string;
    callbackUrl: string;
  },
): Promise<DarajaResult<StkPushResult & { request: Record<string, unknown> }>> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    return {
      ok: false,
      status: "invalid-amount",
      detail: "M-Pesa requires a whole KES amount greater than zero. No prompt was sent.",
    };
  }
  const tokenResult = await darajaToken(creds);
  if (!tokenResult.ok) return tokenResult;

  const timestamp = darajaTimestamp();
  const body = {
    BusinessShortCode: creds.shortCode,
    Password: stkPassword(creds.shortCode, creds.passkey, timestamp),
    Timestamp: timestamp,
    TransactionType: creds.transactionType,
    Amount: input.amount,
    PartyA: input.msisdn,
    PartyB: creds.partyB,
    PhoneNumber: input.msisdn,
    CallBackURL: input.callbackUrl,
    AccountReference: input.accountReference.slice(0, 12) || "NEO",
    TransactionDesc: input.description.trim().slice(0, 13) || "Payment",
  };

  try {
    const res = await fetch(`${darajaHost(creds.environment)}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenResult.data}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status >= 500) {
      return {
        ok: false,
        status: "ambiguous",
        detail:
          "Safaricom returned a server error after the prompt request. Its outcome is uncertain. Check the phone and Recent collections before retrying.",
      };
    }
    let parsed: StkPushResult = {};
    try {
      parsed = JSON.parse(text) as StkPushResult;
    } catch {
      if (res.ok) {
        return {
          ok: false,
          status: "ambiguous",
          detail:
            "Safaricom returned an unreadable response after receiving the prompt request. Check the phone and collection status before retrying.",
        };
      }
      return {
        ok: false,
        status: `http-${res.status}`,
        detail: `Safaricom returned an unreadable STK response (HTTP ${res.status}).`,
      };
    }
    if (!res.ok || parsed.ResponseCode !== "0") {
      return {
        ok: false,
        status: `http-${res.status}`,
        detail: `Safaricom did not accept the STK request (HTTP ${res.status}; code ${parsed.errorCode ?? parsed.ResponseCode ?? "unknown"}).`,
      };
    }
    if (typeof parsed.CheckoutRequestID !== "string" || !parsed.CheckoutRequestID.trim()) {
      return {
        ok: false,
        status: "ambiguous",
        detail:
          "Safaricom accepted the request without a usable checkout reference. Its outcome cannot be tracked automatically. Check the phone and Recent collections before retrying.",
      };
    }
    const safeRequest = { ...body, Password: "[redacted]", CallBackURL: "[redacted]" } as Record<
      string,
      unknown
    >;
    return { ok: true, data: { ...parsed, request: safeRequest } };
  } catch {
    return {
      ok: false,
      status: "ambiguous",
      detail:
        "The connection ended before Safaricom confirmed whether the prompt was received. Check the phone and collection status before retrying.",
    };
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
      signal: AbortSignal.timeout(20_000),
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
      return {
        ok: false,
        status: `http-${res.status}`,
        detail: `Safaricom returned an unreadable status response (HTTP ${res.status}).`,
      };
    }
    if (!res.ok && !parsed.ResultCode) {
      return {
        ok: false,
        status: `http-${res.status}`,
        detail: `Safaricom could not verify the request (HTTP ${res.status}).`,
      };
    }
    return { ok: true, data: parsed };
  } catch {
    return {
      ok: false,
      status: "network",
      detail: "Safaricom could not be reached for status verification.",
    };
  }
}

/** Daraja's compact transaction clock is Kenyan local time, not a SQL timestamp. */
export function darajaTransactionDate(value: unknown): string | null {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const clock = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (clock.getUTCFullYear() !== year || clock.getUTCMonth() !== month - 1 || clock.getUTCDate() !== day) return null;
  return new Date(clock.getTime() - 3 * 60 * 60 * 1000).toISOString();
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
    resultCode: darajaResultCode(code),
    resultDesc: String(cb?.["ResultDesc"] ?? ""),
    receipt: receipt ? String(receipt) : null,
    transactionDate: darajaTransactionDate(txnDate),
    amount: amount === null || amount === undefined ? null : Number(amount),
  };
}

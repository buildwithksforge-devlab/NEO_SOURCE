import { afterEach, describe, expect, it, vi } from "vitest";
import {
  darajaToken,
  darajaResultCode,
  loadMpesaCredentials,
  verifyMpesaServerAccess,
  normaliseMsisdn,
  stkPush,
  type MpesaCredentials,
} from "@/lib/mpesa.server";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        limit: async () => ({ data: null, error: { message: "Invalid API key" } }),
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: { message: "Invalid API key" } }),
        }),
      }),
    }),
  },
}));

const credentials: MpesaCredentials = {
  organizationId: "synthetic-org",
  environment: "production",
  shortCode: "123456",
  partyB: "123456",
  transactionType: "CustomerPayBillOnline",
  accountReference: "NEO",
  consumerKey: "synthetic-consumer-key",
  consumerSecret: "synthetic-consumer-secret",
  passkey: "synthetic-passkey",
  callbackToken: "synthetic-callback-token",
  callbackBaseUrl: "https://example.invalid",
  enabled: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server-side Daraja requests", () => {
  it("rejects a guest-payment preflight when the database gateway rejects the configured key", async () => {
    await expect(verifyMpesaServerAccess()).rejects.toThrow("No guest payment was started");
  });
  it.each([null, undefined, "", " "])(
    "keeps an accepted STK response without checkout reference %s uncertain",
    async (CheckoutRequestID) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
        .mockResolvedValueOnce(Response.json({ ResponseCode: "0", CheckoutRequestID }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await stkPush(credentials, {
        msisdn: "254712345678",
        amount: 25,
        accountReference: "TEST",
        description: "Test",
        callbackUrl: "https://example.invalid/callback",
      });
      expect(result).toMatchObject({ ok: false, status: "ambiguous" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it.each([500, 502, 504])(
    "keeps STK HTTP %s uncertain instead of allowing a fresh collection",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "synthetic-token" })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Provider failure" }), { status }),
        );
      vi.stubGlobal("fetch", fetchMock);
      expect(
        await stkPush(credentials, {
          msisdn: "254712345678",
          amount: 25,
          accountReference: "TEST",
          description: "Test",
          callbackUrl: "https://example.invalid/callback",
        }),
      ).toMatchObject({ ok: false, status: "ambiguous" });
    },
  );
  it.each([null, undefined, "", " ", "0.0", "success", NaN, Infinity, -1])(
    "does not interpret provider result %s as success",
    (value) => {
      expect(darajaResultCode(value)).toBeNull();
    },
  );
  it("accepts explicit integer provider results", () => {
    expect(darajaResultCode("0")).toBe(0);
    expect(darajaResultCode(0)).toBe(0);
    expect(darajaResultCode("1032")).toBe(1032);
  });
  it("rejects unsupported phone numbers instead of accepting incomplete 254 prefixes", () => {
    expect(normaliseMsisdn("+254 712 345 678")).toBe("254712345678");
    expect(normaliseMsisdn("0112345678")).toBe("254112345678");
    expect(normaliseMsisdn("2547")).toBeNull();
    expect(normaliseMsisdn("25471234567899")).toBeNull();
    expect(normaliseMsisdn("0201234567")).toBeNull();
  });
  it.each([0, -1, 25.5, NaN, Infinity])(
    "rejects amount %s without contacting the provider",
    async (amount) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      expect(
        await stkPush(credentials, {
          msisdn: "254712345678",
          amount,
          accountReference: "TEST",
          description: "Test",
          callbackUrl: "https://example.invalid/callback",
        }),
      ).toMatchObject({ ok: false, status: "invalid-amount" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("identifies a rejected database key separately from Daraja authentication", async () => {
    await expect(loadMpesaCredentials("synthetic-org")).rejects.toThrow(
      "Update SUPABASE_SERVICE_ROLE_KEY in the server environment; changing M-Pesa credentials will not fix this database connection",
    );
  });
  it("uses production OAuth with Basic Auth and does not echo provider error bodies", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: credentials.consumerSecret }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await darajaToken(credentials);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials");
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${btoa(`${credentials.consumerKey}:${credentials.consumerSecret}`)}`,
    });
    expect(result).toMatchObject({
      ok: false,
      status: "http-401",
    });
    expect(JSON.stringify(result)).not.toContain(credentials.consumerSecret);
  });

  it("uses the Daraja STK password but redacts password and callback bearer URL from stored request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "synthetic-access-token" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ResponseCode: "0",
            MerchantRequestID: "synthetic-merchant",
            CheckoutRequestID: "synthetic-checkout",
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await stkPush(credentials, {
      msisdn: "254712345678",
      amount: 125,
      accountReference: "RES-TEST",
      description: "Synthetic payment",
      callbackUrl: `https://example.invalid/callback/${credentials.callbackToken}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, init] = fetchMock.mock.calls[1]!;
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
    );
    expect(body).toMatchObject({
      BusinessShortCode: credentials.shortCode,
      TransactionType: "CustomerPayBillOnline",
      Amount: 125,
      PartyA: "254712345678",
      PartyB: credentials.shortCode,
      PhoneNumber: "254712345678",
      CallBackURL: `https://example.invalid/callback/${credentials.callbackToken}`,
      AccountReference: "RES-TEST",
      TransactionDesc: "Synthetic pay",
    });
    expect(body["Timestamp"]).toMatch(/^\d{14}$/);
    expect(body["TransactionDesc"]!.length).toBeLessThanOrEqual(13);
    expect(body["Password"]).toBe(
      btoa(`${credentials.shortCode}${credentials.passkey}${body["Timestamp"]}`),
    );
    expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-access-token" });
    expect(result.data.request).toMatchObject({
      Password: "[redacted]",
      CallBackURL: "[redacted]",
    });
    expect(JSON.stringify(result.data.request)).not.toContain(credentials.passkey);
    expect(JSON.stringify(result.data.request)).not.toContain(credentials.callbackToken);
  });

  it("distinguishes an ambiguous lost STK response from a safe provider rejection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "synthetic-access-token" })),
      )
      .mockRejectedValueOnce(new Error("network detail with synthetic secret"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await stkPush(credentials, {
      msisdn: "254712345678",
      amount: 125,
      accountReference: "RES-TEST",
      description: "Synthetic payment",
      callbackUrl: "https://example.invalid/callback/synthetic-token",
    });

    expect(result).toMatchObject({
      ok: false,
      status: "ambiguous",
      detail: expect.stringContaining("connection ended"),
    });
    expect(JSON.stringify(result)).not.toContain("synthetic secret");
  });

  it("treats an unreadable successful STK response as ambiguous", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "synthetic-access-token" })),
      )
      .mockResolvedValueOnce(new Response("unreadable", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await stkPush(credentials, {
      msisdn: "254712345678",
      amount: 125,
      accountReference: "RES-TEST",
      description: "Synthetic payment",
      callbackUrl: "https://example.invalid/callback/synthetic-token",
    });

    expect(result).toMatchObject({
      ok: false,
      status: "ambiguous",
      detail: expect.stringContaining("unreadable response"),
    });
  });
});

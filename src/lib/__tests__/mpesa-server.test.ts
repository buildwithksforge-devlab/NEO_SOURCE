import { afterEach, describe, expect, it, vi } from "vitest";
import { darajaToken, stkPush, type MpesaCredentials } from "@/lib/mpesa.server";

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

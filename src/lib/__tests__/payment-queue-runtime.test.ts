import { describe, it, expect, vi } from "vitest";

import {

  handlePaymentQueueIngress,

  runPaymentQueueRuntime,

} from "../payment-queue-runtime.server";

import {

  type PaymentQueueEnvelope,

  importPaymentQueueKey,

  openPaymentQueueEvidence,

} from "../payment-queue-transport.server";

const token = "synthetic_payment_token_123456";

const path = "/api/public/mpesa/callback/" + token;

const url =

  "https://neo-preview.neo-hospitality.workers.dev" +

  path;

const keyValue =

  btoa("01234567890123456789012345678901");

const payload = JSON.stringify({

  Body: {

    stkCallback: {

      CheckoutRequestID: "synthetic-checkout",

      ResultCode: 0,

    },

  },

});

async function runtime() {

  const digest = await crypto.subtle.digest(

    "SHA-256",

    new TextEncoder().encode(token),

  );

  const hash = Array.from(

    new Uint8Array(digest),

    value => value.toString(16).padStart(2, "0"),

  ).join("");

  const messages: PaymentQueueEnvelope[] = [];

  const send = vi.fn(async (

    message: PaymentQueueEnvelope,

  ) => {

    messages.push(message);

  });

  const env: Record<string, unknown> = {

    NEO_PAYMENT_QUEUE_ENABLED: "true",

    NEO_LOVABLE_BRIDGE_ENABLED: "true",

    NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED: "true",

    NEO_PAYMENT_CALLBACK_TOKEN_HASHES:

      JSON.stringify([hash]),

    NEO_PAYMENT_QUEUE_ACTIVE_KEY: "test-v1",

    NEO_PAYMENT_QUEUE_KEYS:

      JSON.stringify({ "test-v1": keyValue }),

    NEO_PAYMENT_QUEUE: { send },

  };

  return { env, messages, send };

}

function request(

  target = url,

  body = payload,

) {

  return new Request(target, {

    method: "POST",

    headers: {

      "Content-Type": "application/json",

    },

    body,

  });

}

describe("independent payment queue runtime", () => {

  it("leaves unrelated application routes unchanged", async () => {

    const { env, send } = await runtime();

    expect(

      await handlePaymentQueueIngress(

        new Request("https://example.invalid/"),

        env,

      ),

    ).toBeNull();

    expect(send).not.toHaveBeenCalled();

  });

  it("preserves original handling when queue is disabled", async () => {

    const { env, send } = await runtime();

    env["NEO_PAYMENT_QUEUE_ENABLED"] = "false";

    expect(

      await handlePaymentQueueIngress(request(), env),

    ).toBeNull();

    expect(send).not.toHaveBeenCalled();

  });

  it("authenticates and durably accepts callback evidence", async () => {

    const { env, send, messages } = await runtime();

    const response = await handlePaymentQueueIngress(

      request(),

      env,

    );

    expect(response?.status).toBe(200);

    expect(await response?.json()).toEqual({

      ResultCode: 0,

      ResultDesc: "Accepted",

    });

    expect(send).toHaveBeenCalledTimes(1);

    const key = await importPaymentQueueKey(keyValue);

    expect(

      await openPaymentQueueEvidence(

        messages[0],

        async () => key,

      ),

    ).toEqual({ path, body: payload });

  });

  it("rejects an unregistered callback token", async () => {

    const { env, send } = await runtime();

    const response = await handlePaymentQueueIngress(

      request(

        url.replace(

          token,

          "unknown_payment_token_123456",

        ),

      ),

      env,

    );

    expect(response?.status).toBe(401);

    expect(send).not.toHaveBeenCalled();

  });

  it("rejects an empty token registry", async () => {

    const { env, send } = await runtime();

    env["NEO_PAYMENT_CALLBACK_TOKEN_HASHES"] = "[]";

    expect(

      (await handlePaymentQueueIngress(

        request(), env,

      ))?.status,

    ).toBe(401);

    expect(send).not.toHaveBeenCalled();

  });

  it("never acknowledges failed durable queue intake", async () => {

    const { env, send } = await runtime();

    send.mockRejectedValueOnce(

      new Error("synthetic-queue-outage"),

    );

    expect(

      (await handlePaymentQueueIngress(

        request(), env,

      ))?.status,

    ).toBe(503);

  });

  it("does not use a second settlement backend", async () => {

    const { env, send } = await runtime();

    env["NEO_LOVABLE_BRIDGE_ENABLED"] = "false";

    expect(

      (await handlePaymentQueueIngress(

        request(), env,

      ))?.status,

    ).toBe(503);

    expect(send).not.toHaveBeenCalled();

  });

  it("rejects oversized callback evidence", async () => {

    const { env, send } = await runtime();

    expect(

      (await handlePaymentQueueIngress(

        request(url, "x".repeat(40000)),

        env,

      ))?.status,

    ).toBe(400);

    expect(send).not.toHaveBeenCalled();

  });

  it("rejects non-M-Pesa callback payloads", async () => {

    const { env, send } = await runtime();

    expect(

      (await handlePaymentQueueIngress(

        request(url, '{"unexpected":true}'),

        env,

      ))?.status,

    ).toBe(400);

    expect(send).not.toHaveBeenCalled();

  });

  it("rejects callback query parameters", async () => {

    const { env, send } = await runtime();

    expect(

      (await handlePaymentQueueIngress(

        request(url + "?unexpected=1"),

        env,

      ))?.status,

    ).toBe(400);

    expect(send).not.toHaveBeenCalled();

  });

  it("fails safely when the active encryption key is missing", async () => {

    const { env, send } = await runtime();

    env["NEO_PAYMENT_QUEUE_ACTIVE_KEY"] = "missing";

    expect(

      (await handlePaymentQueueIngress(

        request(), env,

      ))?.status,

    ).toBe(503);

    expect(send).not.toHaveBeenCalled();

  });

  it("forwards queued evidence only to the managed backend", async () => {

    const { env, messages } = await runtime();

    await handlePaymentQueueIngress(request(), env);

    const message = {

      body: messages[0],

      attempts: 1,

      ack: vi.fn(),

      retry: vi.fn(),

    };

    const forward = vi.fn(async (

      _input: RequestInfo | URL,

      _init?: RequestInit,

    ) => Response.json({ ResultCode: 0 }));

    const result = await runPaymentQueueRuntime(

      { messages: [message] },

      env,

      forward as typeof fetch,

    );

    expect(result.completed).toBe(1);

    expect(message.ack).toHaveBeenCalledTimes(1);

    expect(message.retry).not.toHaveBeenCalled();

    expect(forward).toHaveBeenCalledTimes(1);

    const destination = String(

      forward.mock.calls[0]?.[0],

    );

    expect(destination).toContain(

      "https://horizon-prime-os.lovable.app",

    );

  });

  it("retries when the managed backend is unavailable", async () => {

    const { env, messages } = await runtime();

    await handlePaymentQueueIngress(request(), env);

    const message = {

      body: messages[0],

      attempts: 2,

      ack: vi.fn(),

      retry: vi.fn(),

    };

    const result = await runPaymentQueueRuntime(

      { messages: [message] },

      env,

      async () => new Response(null, { status: 503 }),

    );

    expect(result.retried).toBe(1);

    expect(message.ack).not.toHaveBeenCalled();

    expect(message.retry).toHaveBeenCalledTimes(1);

  });

  it("fails the batch if retry persistence is uncertain", async () => {

    const { env, messages } = await runtime();

    await handlePaymentQueueIngress(request(), env);

    const message = {

      body: messages[0],

      attempts: 1,

      ack: vi.fn(),

      retry: vi.fn(() => {

        throw new Error("synthetic-retry-failure");

      }),

    };

    await expect(

      runPaymentQueueRuntime(

        { messages: [message] },

        env,

        async () => new Response(null, {

          status: 503,

        }),

      ),

    ).rejects.toThrow(

      "payment-queue-retry-unconfirmed",

    );

    expect(message.ack).not.toHaveBeenCalled();

  });

  it("retains queued evidence when a previous encryption key is unavailable", async () => {

    const { env, messages } = await runtime();

    await handlePaymentQueueIngress(request(), env);

    env["NEO_PAYMENT_QUEUE_KEYS"] = "{}";

    const message = {

      body: messages[0],

      attempts: 1,

      ack: vi.fn(),

      retry: vi.fn(),

    };

    const forward = vi.fn(async () =>

      Response.json({ ResultCode: 0 }),

    );

    const result = await runPaymentQueueRuntime(

      { messages: [message] },

      env,

      forward,

    );

    expect(result.retried).toBe(1);

    expect(forward).not.toHaveBeenCalled();

    expect(message.ack).not.toHaveBeenCalled();

  });

});
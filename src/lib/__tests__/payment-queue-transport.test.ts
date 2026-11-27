import { describe, it, expect, vi, beforeAll } from "vitest";

import {

  importPaymentQueueKey,

  sealPaymentQueueEvidence,

  openPaymentQueueEvidence,

  enqueuePaymentEvidence,

  consumePaymentTransportBatch,

  paymentQueueRetryDelay,

  type PaymentQueueEnvelope,

} from "../payment-queue-transport.server";

const evidence = {

  path: "/api/public/mpesa/callback/synthetic_token_123456789",

  body: JSON.stringify({

    Body: {

      stkCallback: {

        CheckoutRequestID: "synthetic-checkout",

        ResultCode: 0,

      },

    },

  }),

};

let key: CryptoKey;

beforeAll(async () => {

  key = await importPaymentQueueKey(

    btoa("01234567890123456789012345678901"),

  );

});

const resolveKey = async () => key;

async function createMessage(attempts = 1) {

  return {

    body: await sealPaymentQueueEvidence(

      evidence, "test-key", key,

    ),

    attempts,

    ack: vi.fn(),

    retry: vi.fn(),

  };

}

describe("encrypted payment queue transport", () => {

  it("round trips encrypted callback evidence", async () => {

    const envelope = await sealPaymentQueueEvidence(

      evidence, "test-key", key,

    );

    expect(

      await openPaymentQueueEvidence(envelope, resolveKey),

    ).toEqual(evidence);

  });

  it("does not expose callback tokens or payment payloads", async () => {

    const envelope = await sealPaymentQueueEvidence(

      evidence, "test-key", key,

    );

    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain("synthetic_token");

    expect(serialized).not.toContain("synthetic-checkout");

    expect(serialized).not.toContain("stkCallback");

  });

  it("generates a fresh encryption nonce for every delivery", async () => {

    const first = await sealPaymentQueueEvidence(

      evidence, "test-key", key,

    );

    const second = await sealPaymentQueueEvidence(

      evidence, "test-key", key,

    );

    expect(first.iv).not.toBe(second.iv);

    expect(first.eventId).not.toBe(second.eventId);

    expect(first.ciphertext).not.toBe(second.ciphertext);

  });

  it("rejects altered encrypted payloads", async () => {

    const envelope = await sealPaymentQueueEvidence(

      evidence, "test-key", key,

    );

    envelope.ciphertext =

      (envelope.ciphertext[0] === "A" ? "B" : "A") +

      envelope.ciphertext.slice(1);

    await expect(

      openPaymentQueueEvidence(envelope, resolveKey),

    ).rejects.toThrow();

  });

  it("rejects altered envelope metadata", async () => {

    const envelope = await sealPaymentQueueEvidence(

      evidence, "test-key", key,

    );

    envelope.receivedAt++;

    await expect(

      openPaymentQueueEvidence(envelope, resolveKey),

    ).rejects.toThrow();

  });

  it("rejects incorrect decryption keys", async () => {

    const envelope = await sealPaymentQueueEvidence(

      evidence, "test-key", key,

    );

    const wrongKey = await importPaymentQueueKey(

      btoa("11234567890123456789012345678901"),

    );

    await expect(

      openPaymentQueueEvidence(

        envelope,

        async () => wrongKey,

      ),

    ).rejects.toThrow();

  });

  it("rejects arbitrary forwarding destinations", async () => {

    await expect(

      sealPaymentQueueEvidence(

        {

          ...evidence,

          path: "https://untrusted.invalid/callback",

        },

        "test-key",

        key,

      ),

    ).rejects.toThrow("invalid-payment-callback-path");

  });

  it("rejects excessively large callback bodies", async () => {

    await expect(

      sealPaymentQueueEvidence(

        {

          ...evidence,

          body: "x".repeat(40000),

        },

        "test-key",

        key,

      ),

    ).rejects.toThrow("invalid-payment-callback-body");

  });

  it("rejects non-object callback JSON", async () => {

    await expect(

      sealPaymentQueueEvidence(

        {

          ...evidence,

          body: "[]",

        },

        "test-key",

        key,

      ),

    ).rejects.toThrow("invalid-payment-callback-payload");

  });

  it("returns only after durable producer acceptance", async () => {

    const send = vi.fn(

      async (_message: PaymentQueueEnvelope) => {},

    );

    const result = await enqueuePaymentEvidence(

      { send },

      evidence,

      "test-key",

      key,

    );

    expect(result.eventId).toBeTruthy();

    expect(send).toHaveBeenCalledTimes(1);

  });

  it("does not confirm failed queue persistence", async () => {

    const send = vi.fn(async () => {

      throw new Error("synthetic-queue-outage");

    });

    await expect(

      enqueuePaymentEvidence(

        { send },

        evidence,

        "test-key",

        key,

      ),

    ).rejects.toThrow("synthetic-queue-outage");

  });

  it("acknowledges confirmed canonical success", async () => {

    const message = await createMessage();

    const result = await consumePaymentTransportBatch(

      { messages: [message] },

      resolveKey,

      async () => Response.json({ ResultCode: 0 }),

    );

    expect(result.completed).toBe(1);

    expect(message.ack).toHaveBeenCalledTimes(1);

    expect(message.retry).not.toHaveBeenCalled();

  });

  it("retries unavailable canonical backend", async () => {

    const message = await createMessage(3);

    const result = await consumePaymentTransportBatch(

      { messages: [message] },

      resolveKey,

      async () => new Response(null, { status: 503 }),

    );

    expect(result.retried).toBe(1);

    expect(message.ack).not.toHaveBeenCalled();

    expect(message.retry).toHaveBeenCalledWith({

      delaySeconds: 20,

    });

  });

  it("retries ambiguous successful HTTP responses", async () => {

    const message = await createMessage();

    const result = await consumePaymentTransportBatch(

      { messages: [message] },

      resolveKey,

      async () => Response.json({ ResultCode: 1 }),

    );

    expect(result.completed).toBe(0);

    expect(message.ack).not.toHaveBeenCalled();

    expect(message.retry).toHaveBeenCalledTimes(1);

  });

  it("does not forward corrupted encrypted messages", async () => {

    const message = await createMessage();

    message.body.receivedAt++;

    const forward = vi.fn(async () =>

      Response.json({ ResultCode: 0 }),

    );

    const result = await consumePaymentTransportBatch(

      { messages: [message] },

      resolveKey,

      forward,

    );

    expect(forward).not.toHaveBeenCalled();

    expect(message.ack).not.toHaveBeenCalled();

    expect(result.retried).toBe(1);

  });

  it("preserves evidence when the encryption key is unavailable", async () => {

    const message = await createMessage();

    const forward = vi.fn(async () =>

      Response.json({ ResultCode: 0 }),

    );

    await consumePaymentTransportBatch(

      { messages: [message] },

      async () => {

        throw new Error("missing-key");

      },

      forward,

    );

    expect(forward).not.toHaveBeenCalled();

    expect(message.retry).toHaveBeenCalledTimes(1);

    expect(message.ack).not.toHaveBeenCalled();

  });

  it("keeps retry delay bounded", () => {

    expect(paymentQueueRetryDelay(1)).toBe(5);

    expect(paymentQueueRetryDelay(2)).toBe(10);

    expect(paymentQueueRetryDelay(100)).toBe(3600);

  });

  it("limits concurrent consumer forwarding", async () => {

    const messages = await Promise.all(

      Array.from({ length: 40 }, () => createMessage()),

    );

    let active = 0;

    let peak = 0;

    const result = await consumePaymentTransportBatch(

      { messages },

      resolveKey,

      async () => {

        active++;

        peak = Math.max(peak, active);

        await new Promise(resolve => setTimeout(resolve, 2));

        active--;

        return Response.json({ ResultCode: 0 });

      },

      4,

    );

    expect(peak).toBeLessThanOrEqual(4);

    expect(result.completed).toBe(40);

    expect(result.retried).toBe(0);

  });

  it("retains unresolved messages when retry persistence fails", async () => {

    const message = await createMessage();

    message.retry.mockImplementation(() => {

      throw new Error("retry-unavailable");

    });

    const result = await consumePaymentTransportBatch(

      { messages: [message] },

      resolveKey,

      async () => new Response(null, { status: 503 }),

    );

    expect(result.unresolved).toBe(1);

    expect(message.ack).not.toHaveBeenCalled();

  });

});
import { describe, it, expect, vi } from "vitest";

import {

  handleWorkerPaymentQueue,

  handleWorkerPaymentSchedule,

  PAYMENT_QUEUE_NAME,

  PAYMENT_DEAD_LETTER_QUEUE_NAME,

} from "../payment-worker-handlers.server";

import {

  importPaymentQueueKey,

  sealPaymentQueueEvidence,

} from "../payment-queue-transport.server";

const keyValue =

  btoa("01234567890123456789012345678901");

const runtime: Record<string, unknown> = {

  NEO_PAYMENT_QUEUE_ENABLED: "true",

  NEO_LOVABLE_BRIDGE_ENABLED: "true",

  NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED: "true",

  NEO_PAYMENT_QUEUE_KEYS:

    JSON.stringify({ "test-v1": keyValue }),

};

async function message() {

  const key = await importPaymentQueueKey(keyValue);

  return {

    body: await sealPaymentQueueEvidence(

      {

        path: "/api/public/mpesa/callback/synthetic_worker_token_1234",

        body: JSON.stringify({

          Body: {

            stkCallback: {

              CheckoutRequestID: "synthetic-worker-checkout",

              ResultCode: 0,

            },

          },

        }),

      },

      "test-v1",

      key,

    ),

    attempts: 1,

    ack: vi.fn(),

    retry: vi.fn(),

  };

}

describe("payment worker execution boundaries", () => {

  it("processes the explicitly configured payment queue", async () => {

    const item = await message();

    const result = await handleWorkerPaymentQueue(

      {

        queue: PAYMENT_QUEUE_NAME,

        messages: [item],

      },

      runtime,

      async () => Response.json({ ResultCode: 0 }),

    );

    expect(result.completed).toBe(1);

    expect(item.ack).toHaveBeenCalledTimes(1);

  });

  it("does not acknowledge an unexpected queue", async () => {

    const item = await message();

    const forward = vi.fn(async () =>

      Response.json({ ResultCode: 0 }),

    );

    await expect(

      handleWorkerPaymentQueue(

        {

          queue: "unrelated-queue",

          messages: [item],

        },

        runtime,

        forward,

      ),

    ).rejects.toThrow("unexpected-payment-queue");

    expect(item.ack).not.toHaveBeenCalled();

    expect(forward).not.toHaveBeenCalled();

  });

  it("does not automatically process dead-letter evidence", async () => {

    const item = await message();

    await expect(

      handleWorkerPaymentQueue(

        {

          queue: PAYMENT_DEAD_LETTER_QUEUE_NAME,

          messages: [item],

        },

        runtime,

      ),

    ).rejects.toThrow("unexpected-payment-queue");

    expect(item.ack).not.toHaveBeenCalled();

  });

  it("drains queued payments while new queue intake is paused", async () => {

    const item = await message();

    const result = await handleWorkerPaymentQueue(

      {

        queue: PAYMENT_QUEUE_NAME,

        messages: [item],

      },

      {

        ...runtime,

        NEO_PAYMENT_QUEUE_ENABLED: "false",

        NEO_PAYMENT_QUEUE_DRAIN_ENABLED: "true",

      },

      async () => Response.json({ ResultCode: 0 }),

    );

    expect(result.completed).toBe(1);

    expect(item.ack).toHaveBeenCalledTimes(1);

  });

  it("does not process payments when both switches are disabled", async () => {

    const item = await message();

    await expect(

      handleWorkerPaymentQueue(

        {

          queue: PAYMENT_QUEUE_NAME,

          messages: [item],

        },

        {

          ...runtime,

          NEO_PAYMENT_QUEUE_ENABLED: "false",

          NEO_PAYMENT_QUEUE_DRAIN_ENABLED: "false",

        },

      ),

    ).rejects.toThrow("payment-queue-runtime-disabled");

    expect(item.ack).not.toHaveBeenCalled();

  });

  it("preserves managed settlement authority", async () => {

    const item = await message();

    await expect(

      handleWorkerPaymentQueue(

        {

          queue: PAYMENT_QUEUE_NAME,

          messages: [item],

        },

        {

          ...runtime,

          NEO_LOVABLE_BRIDGE_ENABLED: "false",

        },

      ),

    ).rejects.toThrow("payment-queue-runtime-disabled");

    expect(item.ack).not.toHaveBeenCalled();

  });

  it("does not start a second scheduler against the managed backend", async () => {

    const result = await handleWorkerPaymentSchedule({

      NEO_PAYMENT_SCHEDULER_ENABLED: "true",

      NEO_LOVABLE_BRIDGE_ENABLED: "true",

    });

    expect(result).toEqual({

      skipped: true,

      reason: "managed-backend-is-authoritative",

    });

  });

  it("keeps automatic scheduling disabled by default", async () => {

    const result = await handleWorkerPaymentSchedule({

      NEO_PAYMENT_SCHEDULER_ENABLED: "false",

    });

    expect(result).toEqual({

      skipped: true,

      reason: "disabled",

    });

  });

});
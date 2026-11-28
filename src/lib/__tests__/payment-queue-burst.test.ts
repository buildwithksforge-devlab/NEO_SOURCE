import { describe, it, expect } from "vitest";

import {

  handlePaymentQueueIngress,

  runPaymentQueueRuntime,

} from "../payment-queue-runtime.server";

import type {

  PaymentQueueEnvelope,

} from "../payment-queue-transport.server";

const TOKEN = "synthetic_burst_payment_token_12345";

const COUNT = 10000;

const UNIQUE = 8000;

const PATH = "/api/public/mpesa/callback/" + TOKEN;

const URL =

  "https://neo-preview.neo-hospitality.workers.dev" + PATH;

function percentile(values: number[], ratio: number) {

  const sorted = [...values].sort((a,b) => a-b);

  return sorted[

    Math.min(

      sorted.length - 1,

      Math.ceil(sorted.length * ratio) - 1,

    )

  ] ?? 0;

}

describe("payment transport burst resilience", () => {

  it("accepts 10000 concurrent synthetic callbacks and drains after an outage", async () => {

    const encrypted: PaymentQueueEnvelope[] = [];

    const digest = await crypto.subtle.digest(

      "SHA-256",

      new TextEncoder().encode(TOKEN),

    );

    const hash = Array.from(

      new Uint8Array(digest),

      value => value.toString(16).padStart(2,"0"),

    ).join("");

    const runtime: Record<string, unknown> = {

      NEO_PAYMENT_QUEUE_ENABLED: "true",

      NEO_LOVABLE_BRIDGE_ENABLED: "true",

      NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED: "true",

      NEO_PAYMENT_CALLBACK_TOKEN_HASHES:

        JSON.stringify([hash]),

      NEO_PAYMENT_QUEUE_ACTIVE_KEY: "burst-v1",

      NEO_PAYMENT_QUEUE_KEYS:

        JSON.stringify({

          "burst-v1":

            btoa("01234567890123456789012345678901"),

        }),

      NEO_PAYMENT_QUEUE: {

        async send(message: PaymentQueueEnvelope) {

          encrypted.push(message);

        },

      },

    };

    const latencies: number[] = [];

    const started = performance.now();

    // Each callback is launched without waiting for the
    // previous callback to complete.

    const responses = await Promise.all(

      Array.from({ length: COUNT }, async (_, index) => {

        const beginning = performance.now();

        const payload = {

          Body: {

            stkCallback: {

              CheckoutRequestID:

                "synthetic-burst-" + (index % UNIQUE),

              ResultCode: 0,

            },

          },

        };

        const response = await handlePaymentQueueIngress(

          new Request(URL, {

            method: "POST",

            headers: {

              "Content-Type": "application/json",

            },

            body: JSON.stringify(payload),

          }),

          runtime,

        );

        latencies.push(

          performance.now() - beginning,

        );

        return response?.status;

      }),

    );

    const intakeDuration = performance.now() - started;

    expect(responses).toHaveLength(COUNT);

    expect(

      responses.filter(status => status === 200),

    ).toHaveLength(COUNT);

    expect(encrypted).toHaveLength(COUNT);

    expect(

      new Set(encrypted.map(item => item.eventId)).size,

    ).toBe(COUNT);

    console.info(

      "BURST_INTAKE",

      JSON.stringify({

        arrivals: COUNT,

        accepted: encrypted.length,

        elapsedMs: Math.round(intakeDuration),

        p50Ms: Math.round(percentile(latencies, 0.50)),

        p95Ms: Math.round(percentile(latencies, 0.95)),

        p99Ms: Math.round(percentile(latencies, 0.99)),

      }),

    );

    let acknowledged = 0;

    let retried = 0;

    let peakForwarding = 0;

    let activeForwarding = 0;

    const messages = encrypted.map(body => ({

      body,

      attempts: 1,

      ack() {

        acknowledged++;

      },

      retry() {

        retried++;

      },

    }));

    // Simulate a temporarily unavailable managed backend.

    const outage = await runPaymentQueueRuntime(

      { messages: messages.slice(0, 20) },

      runtime,

      async () => new Response(null, {

        status: 503,

      }),

    );

    expect(outage.retried).toBe(20);

    expect(outage.completed).toBe(0);

    expect(acknowledged).toBe(0);

    expect(retried).toBe(20);

    console.info(

      "BURST_OUTAGE",

      JSON.stringify({

        retained: encrypted.length,

        retried,

        acknowledged,

      }),

    );

    // The synthetic backend uses a Set to model
    // idempotent application. This is not a GL test.

    const applied = new Set<string>();

    let duplicates = 0;

    let forwarded = 0;

    const upstream: typeof fetch = async (

      _input,

      init,

    ) => {

      activeForwarding++;

      peakForwarding = Math.max(

        peakForwarding,

        activeForwarding,

      );

      try {

        const body = await new Response(

          init?.body ?? null,

        ).text();

        const parsed = JSON.parse(body) as {

          Body: {

            stkCallback: {

              CheckoutRequestID: string;

            };

          };

        };

        const checkout =

          parsed.Body.stkCallback.CheckoutRequestID;

        forwarded++;

        if (applied.has(checkout)) {

          duplicates++;

        } else {

          applied.add(checkout);

        }

        await Promise.resolve();

        return Response.json({ ResultCode: 0 });

      } finally {

        activeForwarding--;

      }

    };

    const recoveryStarted = performance.now();

    for (let index = 0; index < messages.length; index += 20) {

      const result = await runPaymentQueueRuntime(

        {

          messages: messages.slice(index,index+20),

        },

        runtime,

        upstream,

      );

      expect(result.unresolved).toBe(0);

      expect(result.retried).toBe(0);

      expect(result.completed).toBe(

        Math.min(20,messages.length-index),

      );

    }

    expect(acknowledged).toBe(COUNT);

    expect(forwarded).toBe(COUNT);

    expect(applied.size).toBe(UNIQUE);

    expect(duplicates).toBe(COUNT-UNIQUE);

    expect(peakForwarding).toBeLessThanOrEqual(4);

    console.info(

      "BURST_RECOVERY",

      JSON.stringify({

        forwarded,

        acknowledged,

        uniqueSyntheticTransactions: applied.size,

        duplicateDeliveries: duplicates,

        peakForwarding,

        recoveryMs: Math.round(

          performance.now()-recoveryStarted,

        ),

        unresolved: COUNT-acknowledged,

      }),

    );

  }, 180000);

});
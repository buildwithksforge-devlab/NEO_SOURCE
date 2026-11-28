import { describe, it, expect, vi } from "vitest";

import {
  createMpesaCallbackEnvelope,
  acceptAuthenticatedCallback,
} from "../payment-callback-inbox.server";

import {
  consumePaymentCallbackBatch,
} from "../payment-callback-consumer.server";

import {
  runPaymentCallbackScheduler,
  runConfiguredPaymentScheduler,
} from "../payment-callback-scheduler.server";

import {
  processAuthenticatedMpesaCallback,
  type CallbackAdmin,
} from "../mpesa-callback-processing.server";

vi.mock("../mpesa-callback-processing.server", () => ({

  processAuthenticatedMpesaCallback: vi.fn(),

}));

vi.mock("@/lib/mpesa.server", () => ({

  readStkCallback: () => ({

    checkoutRequestId: "synthetic-checkout",

    merchantRequestId: "synthetic-merchant",

    resultCode: 0,

    receipt: "synthetic-receipt",

    amount: 100,

  }),

}));

const event = {

  id: "synthetic-event",

  provider: "mpesa",

  endpoint_scope: "synthetic-org",

  lease_token: "synthetic-lease",

  attempt_count: 1,

  payload: { test: true },

};

function createAdmin(

  handler: (

    fn: string,

    args?: Record<string, unknown>,

  ) => unknown,

): CallbackAdmin {

  return {

    from: vi.fn(),

    rpc: vi.fn(async (fn, args) => ({

      data: handler(fn, args),

      error: null,

    })),

  };

}

describe("durable payment callback processing", () => {

  it("identical JSON with different property order has stable identity", async () => {

    const first = await createMpesaCallbackEnvelope(

      "synthetic-org",

      { b: 2, a: { z: 3, x: 1 } },

    );

    const second = await createMpesaCallbackEnvelope(

      "synthetic-org",

      { a: { x: 1, z: 3 }, b: 2 },

    );

    expect(first.eventKey).toBe(second.eventKey);

  });

  it("changed provider evidence receives distinct identity", async () => {

    const first = await createMpesaCallbackEnvelope(

      "synthetic-org",

      { amount: 100, receipt: "A" },

    );

    const second = await createMpesaCallbackEnvelope(

      "synthetic-org",

      { amount: 200, receipt: "A" },

    );

    expect(first.eventKey).not.toBe(second.eventKey);

  });

  it("never confirms failed durable acceptance", async () => {

    const admin = createAdmin(() => ({

      accepted: false,

    }));

    const envelope = await createMpesaCallbackEnvelope(

      "synthetic-org",

      { test: true },

    );

    await expect(

      acceptAuthenticatedCallback(admin, envelope),

    ).rejects.toThrow(

      "callback-durable-acceptance-unconfirmed",

    );

  });

  it("duplicate durable acceptance preserves event identity", async () => {

    const admin = createAdmin(() => ({

      accepted: true,

      event_id: "existing-event",

      duplicate: true,

      status: "completed",

    }));

    const envelope = await createMpesaCallbackEnvelope(

      "synthetic-org",

      { test: true },

    );

    const result = await acceptAuthenticatedCallback(

      admin,

      envelope,

    );

    expect(result.eventId).toBe("existing-event");

    expect(result.duplicate).toBe(true);

  });

  it("consumer refuses processing when lease renewal fails", async () => {

    vi.clearAllMocks();

    const admin = createAdmin(fn => {

      if (fn === "neo_payment_callback_claim") return [event];

      if (fn === "neo_payment_callback_renew") return false;

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.unresolved).toBe(1);

    expect(processAuthenticatedMpesaCallback).not.toHaveBeenCalled();

  });

  it("consumer completes only after canonical acknowledgement", async () => {

    vi.clearAllMocks();

    vi.mocked(processAuthenticatedMpesaCallback)

      .mockResolvedValueOnce(

        Response.json({ ResultCode: 0 }),

      );

    const admin = createAdmin(fn => {

      if (fn === "neo_payment_callback_claim") return [event];

      if (fn === "neo_payment_callback_renew") return true;

      if (fn === "neo_payment_callback_complete") return true;

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.completed).toBe(1);

    expect(result.unresolved).toBe(0);

  });

  it("conflicting provider evidence enters dead-letter recovery", async () => {

    vi.clearAllMocks();

    vi.mocked(processAuthenticatedMpesaCallback)

      .mockResolvedValueOnce(

        new Response("Conflict", { status: 409 }),

      );

    const admin = createAdmin((fn, args) => {

      if (fn === "neo_payment_callback_claim") return [event];

      if (fn === "neo_payment_callback_renew") return true;

      if (fn === "neo_payment_callback_fail") {

        expect(args?.["_permanent"]).toBe(true);

        return { ok: true, status: "dead-letter" };

      }

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.deadLetter).toBe(1);

    expect(result.completed).toBe(0);

  });

  it("temporary backend failure retains retry evidence", async () => {

    vi.clearAllMocks();

    vi.mocked(processAuthenticatedMpesaCallback)

      .mockResolvedValueOnce(

        new Response("Unavailable", { status: 503 }),

      );

    const admin = createAdmin((fn, args) => {

      if (fn === "neo_payment_callback_claim") return [event];

      if (fn === "neo_payment_callback_renew") return true;

      if (fn === "neo_payment_callback_fail") {

        expect(args?.["_permanent"]).toBe(false);

        return { ok: true, status: "retry" };

      }

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.retryScheduled).toBe(1);

  });

  it("scheduler stops when database claim is unavailable", async () => {

    const admin = createAdmin(() => {

      throw new Error("synthetic-database-outage");

    });

    const result = await runPaymentCallbackScheduler(admin);

    expect(result.backendUnavailable).toBe(true);

    expect(result.stoppedForBackpressure).toBe(true);

  });

  it("managed bridge prevents local financial scheduler", async () => {

    const result = await runConfiguredPaymentScheduler({

      NEO_PAYMENT_SCHEDULER_ENABLED: "true",

      NEO_LOVABLE_BRIDGE_ENABLED: "true",

    });

    expect(result).toEqual({

      skipped: true,

      reason: "managed-backend-is-authoritative",

    });

  });

  it("disabled scheduler never opens settlement client", async () => {

    const result = await runConfiguredPaymentScheduler({

      NEO_PAYMENT_SCHEDULER_ENABLED: "false",

    });

    expect(result).toEqual({

      skipped: true,

      reason: "disabled",

    });

  });

});

// STAGE_11_RECOVERY_TESTS

describe("payment interruption and recovery boundaries", () => {

  it("does not report completion when lease completion is rejected", async () => {

    vi.clearAllMocks();

    vi.mocked(processAuthenticatedMpesaCallback)
      .mockResolvedValueOnce(
        Response.json({ ResultCode: 0 }),
      );

    const admin = createAdmin(fn => {

      if (fn === "neo_payment_callback_claim") return [event];

      if (fn === "neo_payment_callback_renew") return true;

      if (fn === "neo_payment_callback_complete") return false;

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.completed).toBe(0);

    expect(result.unresolved).toBe(1);

  });

  it("retains unresolved evidence when retry persistence fails", async () => {

    vi.clearAllMocks();

    vi.mocked(processAuthenticatedMpesaCallback)
      .mockResolvedValueOnce(
        new Response("Unavailable", { status: 503 }),
      );

    const admin = createAdmin(fn => {

      if (fn === "neo_payment_callback_claim") return [event];

      if (fn === "neo_payment_callback_renew") return true;

      if (fn === "neo_payment_callback_fail") {
        throw new Error("synthetic-retry-persistence-outage");
      }

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.unresolved).toBe(1);

    expect(result.completed).toBe(0);

    expect(result.retryScheduled).toBe(0);

  });

  it("retains invalid canonical acknowledgement for recovery", async () => {

    vi.clearAllMocks();

    vi.mocked(processAuthenticatedMpesaCallback)
      .mockResolvedValueOnce(
        Response.json({ ResultCode: 1 }),
      );

    const admin = createAdmin(fn => {

      if (fn === "neo_payment_callback_claim") return [event];

      if (fn === "neo_payment_callback_renew") return true;

      if (fn === "neo_payment_callback_fail") {
        return { ok: true, status: "retry" };
      }

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.completed).toBe(0);

    expect(result.retryScheduled).toBe(1);

  });

  it("does not send unsupported providers to the settlement engine", async () => {

    vi.clearAllMocks();

    const admin = createAdmin((fn,args) => {

      if (fn === "neo_payment_callback_claim") {
        return [{ ...event, provider: "unsupported" }];
      }

      if (fn === "neo_payment_callback_fail") {

        expect(args?.["_permanent"]).toBe(true);

        return { ok: true, status: "dead-letter" };

      }

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.deadLetter).toBe(1);

    expect(processAuthenticatedMpesaCallback)
      .not.toHaveBeenCalled();

  });

  it("empty queue causes no provider processing", async () => {

    vi.clearAllMocks();

    const admin = createAdmin(fn => {

      if (fn === "neo_payment_callback_claim") return [];

      throw new Error("unexpected-rpc");

    });

    const result = await consumePaymentCallbackBatch(admin);

    expect(result.claimed).toBe(0);

    expect(result.completed).toBe(0);

    expect(processAuthenticatedMpesaCallback)
      .not.toHaveBeenCalled();

  });

  it("scheduler stops after an empty processing wave", async () => {

    const admin = createAdmin(fn => {

      if (fn === "neo_payment_callback_claim") return [];

      throw new Error("unexpected-rpc");

    });

    const result = await runPaymentCallbackScheduler(admin);

    expect(result.claimed).toBe(0);

    expect(result.backendUnavailable).toBe(false);

    expect(admin.rpc).toHaveBeenCalledTimes(1);

  });

  it("scheduler stops when every claimed event is unresolved", async () => {

    vi.clearAllMocks();

    const admin = createAdmin(fn => {

      if (fn === "neo_payment_callback_claim") return [event];

      if (fn === "neo_payment_callback_renew") return false;

      throw new Error("unexpected-rpc");

    });

    const result = await runPaymentCallbackScheduler(admin);

    expect(result.waves).toBe(1);

    expect(result.unresolved).toBe(1);

    expect(result.stoppedForBackpressure).toBe(true);

  });

  it("consumer rejects excessive configured concurrency", async () => {

    const admin = createAdmin(() => []);

    await expect(
      consumePaymentCallbackBatch(admin, {
        concurrency: 100,
      }),
    ).rejects.toThrow(
      "invalid-callback-consumer-limits",
    );

    expect(admin.rpc).not.toHaveBeenCalled();

  });

  it("scheduler rejects invalid runtime budgets", async () => {

    const admin = createAdmin(() => []);

    await expect(
      runPaymentCallbackScheduler(admin, {
        runtimeBudgetMs: -1,
      }),
    ).rejects.toThrow(
      "invalid-payment-scheduler-limits",
    );

    expect(admin.rpc).not.toHaveBeenCalled();

  });

});

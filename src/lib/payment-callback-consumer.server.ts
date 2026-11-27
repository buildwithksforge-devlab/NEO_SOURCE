import {
  processAuthenticatedMpesaCallback,
  type CallbackAdmin,
} from "./mpesa-callback-processing.server";

type InboxEvent = {

  id: string;

  provider: string;

  endpoint_scope: string;

  payload: Record<string, unknown>;

  lease_token: string;

  attempt_count: number;

};

type ConsumerOptions = {

  batchSize?: number;

  concurrency?: number;

};

export async function consumePaymentCallbackBatch(
  admin: CallbackAdmin,
  options: ConsumerOptions = {},
) {

  const batchSize = options.batchSize ?? 20;

  const concurrency = options.concurrency ?? 4;

  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 10
  ) {

    throw new Error("invalid-callback-consumer-limits");

  }

  // Claim only as much as can begin processing immediately.
  // Avoid holding a large batch while its leases expire.

  const claimed = await admin.rpc(

    "neo_payment_callback_claim",

    {

      _limit: Math.min(batchSize, concurrency),

      _lease_seconds: 300,

    },
  );

  if (
    claimed.error ||
    !Array.isArray(claimed.data)
  ) {

    throw new Error("callback-claim-unavailable");

  }

  const events = claimed.data as InboxEvent[];

  const results = {

    claimed: events.length,

    completed: 0,

    retryScheduled: 0,

    deadLetter: 0,

    unresolved: 0,

  };

  async function fail(
    event: InboxEvent,
    code: string,
    permanent = false,
  ) {

    try {

      const result = await admin.rpc(

        "neo_payment_callback_fail",

        {

          _event: event.id,

          _lease: event.lease_token,

          _error_code: code,

          _permanent: permanent,

        },
      );

      if (
        result.error ||
        result.data?.ok !== true
      ) {

        results.unresolved++;

      } else if (
        result.data.status === "dead-letter"
      ) {

        results.deadLetter++;

      } else {

        results.retryScheduled++;

      }

    } catch {

      // The event remains durably stored.
      // The lease expiry permits subsequent recovery.

      results.unresolved++;

    }
  }

  await Promise.all(

    events.map(async event => {

      try {

        if (
          event.provider !== "mpesa" ||
          !event.endpoint_scope ||
          !event.lease_token
        ) {

          await fail(
            event,
            "unsupported-callback-envelope",
            true,
          );

          return;

        }        const renewal = await admin.rpc(

          "neo_payment_callback_renew",

          {

            _event: event.id,

            _lease: event.lease_token,

            _seconds: 300,

          },

        );

        if (

          renewal.error ||

          renewal.data !== true

        ) {

          results.unresolved++;

          return;

        }

        const response =
          await processAuthenticatedMpesaCallback(

            admin,

            event.endpoint_scope,            event.payload,

            { queued: true },

          );

        if (!response.ok) {

          await fail(
            event,            response.status === 409
              ? "provider-evidence-conflict"
              : "canonical-processing-unresolved",

            response.status === 409,

          );

          return;

        }

        const acknowledgement: unknown =
          await response.json();

        if (
          !acknowledgement ||
          typeof acknowledgement !== "object" ||
          !("ResultCode" in acknowledgement) ||
          acknowledgement.ResultCode !== 0
        ) {

          await fail(
            event,
            "invalid-canonical-acknowledgement",
          );

          return;

        }

        const completion = await admin.rpc(

          "neo_payment_callback_complete",

          {

            _event: event.id,

            _lease: event.lease_token,

          },
        );

        if (
          completion.error ||
          completion.data !== true
        ) {

          results.unresolved++;

          return;

        }

        results.completed++;

      } catch {

        await fail(
          event,
          "callback-processing-interrupted",
        );

      }

    }),

  );

  return results;
}
import {

  runPaymentQueueRuntime,

} from "./payment-queue-runtime.server";

import {

  runConfiguredPaymentScheduler,

} from "./payment-callback-scheduler.server";

import type {

  PaymentQueueBatch,

} from "./payment-queue-transport.server";

export const PAYMENT_QUEUE_NAME =

  "neo-preview-payment-callbacks";

export const PAYMENT_DEAD_LETTER_QUEUE_NAME =

  "neo-preview-payment-callbacks-dlq";

export interface NamedPaymentBatch extends PaymentQueueBatch {

  queue: string;

}

export async function handleWorkerPaymentQueue(

  batch: NamedPaymentBatch,

  runtime: Record<string, unknown>,

  upstreamFetch: typeof fetch = fetch,

) {

  if (batch.queue !== PAYMENT_QUEUE_NAME) {

    // Unknown queues must never be silently acknowledged.

    throw new Error("unexpected-payment-queue");

  }

  const totals = await runPaymentQueueRuntime(

    batch,

    runtime,

    upstreamFetch,

  );

  if (

    totals.completed + totals.retried !== totals.received ||

    totals.unresolved !== 0

  ) {

    throw new Error("incomplete-payment-queue-batch");

  }

  console.info(

    "NEO_PAYMENT_QUEUE_BATCH",

    JSON.stringify(totals),

  );

  return totals;

}

export async function handleWorkerPaymentSchedule(

  runtime: Record<string, unknown>,

) {

  return runConfiguredPaymentScheduler(runtime);

}
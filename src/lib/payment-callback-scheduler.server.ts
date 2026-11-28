import { consumePaymentCallbackBatch } from "./payment-callback-consumer.server";
import type { CallbackAdmin } from "./mpesa-callback-processing.server";

type SchedulerOptions = {

  maxWaves?: number;

  concurrency?: number;

  runtimeBudgetMs?: number;

};

export async function runPaymentCallbackScheduler(
  admin: CallbackAdmin,
  options: SchedulerOptions = {},
) {

  const maxWaves = options.maxWaves ?? 20;

  const concurrency = options.concurrency ?? 4;

  const runtimeBudgetMs = options.runtimeBudgetMs ?? 20000;

  if (
    !Number.isInteger(maxWaves) ||
    maxWaves < 1 ||
    maxWaves > 100 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 10 ||
    !Number.isFinite(runtimeBudgetMs) ||
    runtimeBudgetMs < 1000 ||
    runtimeBudgetMs > 60000
  ) {

    throw new Error("invalid-payment-scheduler-limits");

  }

  const started = Date.now();

  const totals = {

    waves: 0,

    claimed: 0,

    completed: 0,

    retryScheduled: 0,

    deadLetter: 0,

    unresolved: 0,

    backendUnavailable: false,

    stoppedForBackpressure: false,

    durationMs: 0,

  };

  for (let wave = 0; wave < maxWaves; wave++) {

    if (Date.now() - started >= runtimeBudgetMs) break;

    let result;

    try {

      result = await consumePaymentCallbackBatch(

        admin,

        {
          batchSize: concurrency,
          concurrency,
        },

      );

    } catch {

      totals.backendUnavailable = true;

      totals.stoppedForBackpressure = true;

      break;

    }

    if (result.claimed === 0) break;

    totals.waves++;

    totals.claimed += result.claimed;

    totals.completed += result.completed;

    totals.retryScheduled += result.retryScheduled;

    totals.deadLetter += result.deadLetter;

    totals.unresolved += result.unresolved;

    // Stop this execution if an entire processing wave
    // encounters an unavailable or unresolved backend.

    if (

      result.completed === 0 &&

      result.retryScheduled + result.unresolved === result.claimed

    ) {

      totals.stoppedForBackpressure = true;

      break;

    }

  }

  totals.durationMs = Date.now() - started;

  return totals;
}

export async function runConfiguredPaymentScheduler(
  runtime: Record<string, unknown>,
) {

  const setting = (name: string) =>

    runtime[name] ?? process.env[name];

  if (setting("NEO_PAYMENT_SCHEDULER_ENABLED") !== "true") {

    return { skipped: true, reason: "disabled" };

  }

  // Never establish an independent settlement path
  // inside the managed transport Worker.

  if (setting("NEO_LOVABLE_BRIDGE_ENABLED") === "true") {

    return {
      skipped: true,
      reason: "managed-backend-is-authoritative",
    };

  }

  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );

  return runPaymentCallbackScheduler(

    supabaseAdmin as unknown as CallbackAdmin,

    {

      maxWaves: 20,

      concurrency: 4,

      runtimeBudgetMs: 20000,

    },

  );
}
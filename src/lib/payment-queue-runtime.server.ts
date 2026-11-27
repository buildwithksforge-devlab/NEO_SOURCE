import {
  validatePaymentQueueConfiguration,
} from "./payment-queue-security.server";

import {

  importPaymentQueueKey,

  enqueuePaymentEvidence,

  consumePaymentTransportBatch,

  type PaymentQueueProducer,

  type PaymentQueueBatch,

  type PaymentQueueEvidence,

} from "./payment-queue-transport.server";

import {
  forwardManagedMpesaCallback,
} from "./mpesa-callback-relay";

const MAX_BODY_BYTES = 32768;

const encoder = new TextEncoder();

function unavailable() {

  return Response.json(

    { error: "Payment intake temporarily unavailable" },

    {

      status: 503,

      headers: {

        "Cache-Control": "no-store",

        "Retry-After": "10",

      },

    },

  );

}

function setting(

  runtime: Record<string, unknown>,

  name: string,

): unknown {

  return runtime[name];

}

async function sha256(value: string): Promise<string> {

  const result = await crypto.subtle.digest(

    "SHA-256",

    encoder.encode(value),

  );

  return Array.from(

    new Uint8Array(result),

    byte => byte.toString(16).padStart(2, "0"),

  ).join("");

}

function equalDigest(a: string, b: string): boolean {

  if (a.length !== b.length) return false;

  let difference = 0;

  for (let i = 0; i < a.length; i++) {

    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);

  }

  return difference === 0;

}

async function authenticateCallbackToken(

  token: string,

  runtime: Record<string, unknown>,

): Promise<boolean> {

  const configured = setting(

    runtime,

    "NEO_PAYMENT_CALLBACK_TOKEN_HASHES",

  );

  if (

    typeof configured !== "string" ||

    configured.length > 100000

  ) {

    return false;

  }

  const hashes: unknown = JSON.parse(configured);

  if (

    !Array.isArray(hashes) ||

    hashes.length === 0 ||

    hashes.length > 1000

  ) {

    return false;

  }

  const digest = await sha256(token);

  let matched = 0;

  for (const candidate of hashes) {

    if (

      typeof candidate !== "string" ||

      !/^[a-f0-9]{64}$/i.test(candidate)

    ) {

      return false;

    }

    matched |= Number(

      equalDigest(digest, candidate.toLowerCase()),

    );

  }

  return matched === 1;

}


// NEO_PAYMENT_SECURITY_ENFORCEMENT_V1

const paymentKeyCache = new Map<
  string,
  {
    encoded: string;
    key: Promise<CryptoKey>;
  }
>();

const MAX_CACHED_PAYMENT_KEYS = 32;

async function importCachedPaymentKey(
  keyId: string,
  encoded: string,
): Promise<CryptoKey> {

  const existing = paymentKeyCache.get(keyId);

  if (existing?.encoded === encoded) {
    return existing.key;
  }

  if (
    !existing &&
    paymentKeyCache.size >= MAX_CACHED_PAYMENT_KEYS
  ) {

    const oldest = paymentKeyCache.keys().next().value;

    if (oldest !== undefined) {
      paymentKeyCache.delete(oldest);
    }

  }

  const entry = {
    encoded,
    key: importPaymentQueueKey(encoded),
  };

  paymentKeyCache.set(keyId, entry);

  try {

    return await entry.key;

  } catch (error) {

    if (paymentKeyCache.get(keyId) === entry) {
      paymentKeyCache.delete(keyId);
    }

    throw error;

  }

}

async function resolveRuntimeKey(

  runtime: Record<string, unknown>,

  keyId: string,

): Promise<CryptoKey> {

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {

    throw new Error("invalid-payment-key-id");

  }

  const configured = setting(

    runtime,

    "NEO_PAYMENT_QUEUE_KEYS",

  );

  if (

    typeof configured !== "string" ||

    configured.length > 65536

  ) {

    throw new Error("payment-key-registry-unavailable");

  }

  const registry: unknown = JSON.parse(configured);

  if (

    !registry ||

    typeof registry !== "object" ||

    Array.isArray(registry)

  ) {

    throw new Error("invalid-payment-key-registry");

  }

  const keys = registry as Record<string, unknown>;

  if (!Object.prototype.hasOwnProperty.call(keys, keyId)) {

    throw new Error("payment-queue-key-unavailable");

  }

  const encodedKey = keys[keyId];

  if (typeof encodedKey !== "string") {

    throw new Error("payment-queue-key-unavailable");

  }

  return importCachedPaymentKey(keyId, encodedKey);

}

async function readBoundedBody(

  request: Request,

): Promise<string> {

  const declared = request.headers.get("Content-Length");

  if (declared !== null) {

    const length = Number(declared);

    if (

      !Number.isSafeInteger(length) ||

      length < 0 ||

      length > MAX_BODY_BYTES

    ) {

      throw new Error("payment-body-too-large");

    }

  }

  if (!request.body) {

    throw new Error("payment-body-required");

  }

  const reader = request.body.getReader();

  const chunks: Uint8Array[] = [];

  let total = 0;

  try {

    while (true) {

      const result = await reader.read();

      if (result.done) break;

      total += result.value.byteLength;

      if (total > MAX_BODY_BYTES) {

        await reader.cancel();

        throw new Error("payment-body-too-large");

      }

      chunks.push(result.value);

    }

  } finally {

    reader.releaseLock();

  }

  const bytes = new Uint8Array(total);

  let offset = 0;

  for (const chunk of chunks) {

    bytes.set(chunk, offset);

    offset += chunk.byteLength;

  }

  return new TextDecoder("utf-8", {

    fatal: true,

  }).decode(bytes);

}

function validMpesaPayload(body: string): boolean {

  const value: unknown = JSON.parse(body);

  if (

    !value ||

    typeof value !== "object" ||

    Array.isArray(value)

  ) {

    return false;

  }

  const root = value as Record<string, unknown>;

  const bodyObject = root["Body"];

  if (

    !bodyObject ||

    typeof bodyObject !== "object" ||

    Array.isArray(bodyObject)

  ) {

    return false;

  }

  const callback = (

    bodyObject as Record<string, unknown>

  )["stkCallback"];

  if (

    !callback ||

    typeof callback !== "object" ||

    Array.isArray(callback)

  ) {

    return false;

  }

  const fields = callback as Record<string, unknown>;

  const checkout = fields["CheckoutRequestID"];

  const resultCode = fields["ResultCode"];

  return (

    typeof checkout === "string" &&

    checkout.trim().length > 0 &&

    checkout.length <= 256 &&

    typeof resultCode === "number" &&

    Number.isSafeInteger(resultCode)

  );

}


type CachedPaymentReadiness = {
  signature: string;
  validation: ReturnType<
    typeof validatePaymentQueueConfiguration
  >;
};

let cachedPaymentReadiness:
  CachedPaymentReadiness | undefined;

async function paymentTransportReady(
  runtime: Record<string, unknown>,
): Promise<boolean> {

  const producer = runtime["NEO_PAYMENT_QUEUE"] as
    { send?: unknown } | undefined;

  if (!producer || typeof producer.send !== "function") {
    return false;
  }

  const names = [
    "NEO_PAYMENT_CALLBACK_TOKEN_HASHES",
    "NEO_PAYMENT_QUEUE_KEYS",
    "NEO_PAYMENT_QUEUE_ACTIVE_KEY",
    "NEO_LOVABLE_BRIDGE_ENABLED",
    "NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED",
  ];

  const values = names.map(name => runtime[name]);

  if (
    !values.every(value => typeof value === "string")
  ) {
    return false;
  }

  const tokens = runtime[
    "NEO_PAYMENT_CALLBACK_TOKEN_HASHES"
  ] as string;

  const keys = runtime[
    "NEO_PAYMENT_QUEUE_KEYS"
  ] as string;

  const active = runtime[
    "NEO_PAYMENT_QUEUE_ACTIVE_KEY"
  ] as string;

  if (
    tokens.length > 100000 ||
    keys.length > 65536 ||
    active.length > 64
  ) {
    return false;
  }

  const signature = JSON.stringify(values);

  if (
    !cachedPaymentReadiness ||
    cachedPaymentReadiness.signature !== signature
  ) {

    cachedPaymentReadiness = {
      signature,
      validation:
        validatePaymentQueueConfiguration(runtime),
    };

  }

  try {

    const result =
      await cachedPaymentReadiness.validation;

    return result.transportReady;

  } catch {

    return false;

  }

}

export async function handlePaymentQueueIngress(

  request: Request,

  runtime: Record<string, unknown>,

): Promise<Response | null> {

  const url = new URL(request.url);

  if (

    !url.pathname.startsWith(

      "/api/public/mpesa/callback/",

    )

  ) {

    return null;

  }

  if (

    setting(runtime, "NEO_PAYMENT_QUEUE_ENABLED")

      !== "true"

  ) {

    return null;

  }

  // Only use this transport for the configured
  // authoritative managed backend.

  if (

    setting(runtime, "NEO_LOVABLE_BRIDGE_ENABLED")

      !== "true" ||

    setting(runtime, "NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED")

      !== "true"

  ) {

    return unavailable();

  }

  const pathMatch = url.pathname.match(

    /^\/api\/public\/mpesa\/callback\/([A-Za-z0-9_-]{16,256})$/,

  );

  if (

    !pathMatch ||

    url.search ||

    request.method !== "POST"

  ) {

    return new Response("Invalid callback request", {

      status: 400,

      headers: { "Cache-Control": "no-store" },

    });

  }

  const contentType = request.headers

    .get("Content-Type")

    ?.split(";")[0]

    ?.trim()

    .toLowerCase();

  if (contentType !== "application/json") {

    return new Response("Unsupported content type", {

      status: 415,

    });

  }

  try {

    const token = pathMatch[1];

    if (

      !token ||

      !await authenticateCallbackToken(token, runtime)

    ) {

      return new Response("Unauthorized", {

        status: 401,

        headers: { "Cache-Control": "no-store" },

      });

    }

  } catch {

    return unavailable();

  }

  let body: string;

  try {

    body = await readBoundedBody(request);

    if (!validMpesaPayload(body)) {

      return new Response("Invalid callback payload", {

        status: 400,

      });

    }

  } catch {

    return new Response("Invalid callback body", {

      status: 400,

    });

  }

  try {

    const producer = setting(

      runtime,

      "NEO_PAYMENT_QUEUE",

    ) as PaymentQueueProducer | undefined;

    const keyId = setting(

      runtime,

      "NEO_PAYMENT_QUEUE_ACTIVE_KEY",

    );

    if (

      !producer ||

      typeof producer.send !== "function" ||

      typeof keyId !== "string"

    ) {

      return unavailable();

    }


    // Reject invalid key and token registries before
    // acknowledging durable payment evidence.

    if (!await paymentTransportReady(runtime)) {
      return unavailable();
    }

    const key = await resolveRuntimeKey(runtime, keyId);

    await enqueuePaymentEvidence(

      producer,

      { path: url.pathname, body },

      keyId,

      key,

    );

    // This confirms durable receipt only.
    // It is not confirmation of customer settlement.

    return Response.json(

      {

        ResultCode: 0,

        ResultDesc: "Accepted",

      },

      {

        headers: { "Cache-Control": "no-store" },

      },

    );

  } catch {

    // No local settlement fallback.
    // Never claim receipt if queue persistence failed.

    return unavailable();

  }

}

export async function runPaymentQueueRuntime(

  batch: PaymentQueueBatch,

  runtime: Record<string, unknown>,

  upstreamFetch: typeof fetch = fetch,

) {

  if (

    (
      setting(runtime, "NEO_PAYMENT_QUEUE_ENABLED") !== "true" &&
      setting(runtime, "NEO_PAYMENT_QUEUE_DRAIN_ENABLED") !== "true"
    ) ||

    setting(runtime, "NEO_LOVABLE_BRIDGE_ENABLED")

      !== "true" ||

    setting(runtime, "NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED")

      !== "true"

  ) {

    throw new Error("payment-queue-runtime-disabled");

  }

  const forward = async (

    evidence: PaymentQueueEvidence,

  ): Promise<Response> => {

    const request = new Request(

      "https://neo-preview.neo-hospitality.workers.dev" +

        evidence.path,

      {

        method: "POST",

        headers: {

          "Content-Type": "application/json",

          "Accept": "application/json",

        },

        body: evidence.body,

      },

    );

    const response = await forwardManagedMpesaCallback(

      request,

      runtime,

      upstreamFetch,

    );

    return response ?? unavailable();

  };

  const totals = await consumePaymentTransportBatch(

    batch,

    keyId => resolveRuntimeKey(runtime, keyId),

    forward,

    4,

  );

  if (totals.unresolved > 0) {

    // Do not allow a successful batch return to
    // acknowledge messages whose retry was not recorded.

    throw new Error("payment-queue-retry-unconfirmed");

  }

  return totals;

}
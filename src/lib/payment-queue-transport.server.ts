export interface PaymentQueueEnvelope {

  version: 1;

  keyId: string;

  eventId: string;

  receivedAt: number;

  iv: string;

  ciphertext: string;

}

export interface PaymentQueueEvidence {

  path: string;

  body: string;

}

export interface PaymentQueueProducer {

  send(message: PaymentQueueEnvelope): Promise<void>;

}

export interface PaymentQueueMessage {

  body: unknown;

  attempts: number;

  ack(): void;

  retry(options: { delaySeconds: number }): void;

}

export interface PaymentQueueBatch {

  messages: readonly PaymentQueueMessage[];

}

export type PaymentQueueKeyResolver = (

  keyId: string,

) => Promise<CryptoKey>;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const MAX_BODY_BYTES = 32768;

const MAX_CIPHERTEXT_LENGTH = 100000;

function encodeBase64(bytes: Uint8Array): string {

  let value = "";

  for (const byte of bytes) {

    value += String.fromCharCode(byte);

  }

  return btoa(value);

}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {

  const binary = atob(value);

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {

    bytes[i] = binary.charCodeAt(i);

  }

  return bytes;

}

export async function importPaymentQueueKey(

  encodedKey: string,

): Promise<CryptoKey> {

  const bytes = decodeBase64(encodedKey);

  if (bytes.byteLength !== 32) {

    throw new Error("invalid-payment-queue-key");

  }

  return crypto.subtle.importKey(

    "raw",

    bytes,

    { name: "AES-GCM" },

    false,

    ["encrypt", "decrypt"],

  );

}

function validateEvidence(

  evidence: PaymentQueueEvidence,

): void {

  if (

    typeof evidence.path !== "string" ||

    !/^\/api\/public\/mpesa\/callback\/[A-Za-z0-9_-]{16,256}$/
      .test(evidence.path)

  ) {

    throw new Error("invalid-payment-callback-path");

  }

  if (

    typeof evidence.body !== "string" ||

    encoder.encode(evidence.body).byteLength > MAX_BODY_BYTES

  ) {

    throw new Error("invalid-payment-callback-body");

  }

  const payload: unknown = JSON.parse(evidence.body);

  if (

    !payload ||

    typeof payload !== "object" ||

    Array.isArray(payload)

  ) {

    throw new Error("invalid-payment-callback-payload");

  }

}

function associatedData(

  envelope: Pick<

    PaymentQueueEnvelope,

    "version" | "keyId" | "eventId" | "receivedAt"

  >,

): Uint8Array<ArrayBuffer> {

  return encoder.encode(

    JSON.stringify([

      envelope.version,

      envelope.keyId,

      envelope.eventId,

      envelope.receivedAt,

    ]),

  );

}

export async function sealPaymentQueueEvidence(

  evidence: PaymentQueueEvidence,

  keyId: string,

  key: CryptoKey,

): Promise<PaymentQueueEnvelope> {

  validateEvidence(evidence);

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {

    throw new Error("invalid-payment-queue-key-id");

  }

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const metadata = {

    version: 1 as const,

    keyId,

    eventId: crypto.randomUUID(),

    receivedAt: Date.now(),

  };

  const ciphertext = await crypto.subtle.encrypt(

    {

      name: "AES-GCM",

      iv,

      additionalData: associatedData(metadata),

      tagLength: 128,

    },

    key,

    encoder.encode(JSON.stringify(evidence)),

  );

  return {

    ...metadata,

    iv: encodeBase64(iv),

    ciphertext: encodeBase64(new Uint8Array(ciphertext)),

  };

}

function validateEnvelope(

  input: unknown,

): PaymentQueueEnvelope {

  if (!input || typeof input !== "object") {

    throw new Error("invalid-payment-queue-envelope");

  }

  const value = input as Partial<PaymentQueueEnvelope>;

  if (

    value.version !== 1 ||

    typeof value.keyId !== "string" ||

    !/^[A-Za-z0-9_-]{1,64}$/.test(value.keyId) ||

    typeof value.eventId !== "string" ||

    !/^[a-f0-9-]{36}$/i.test(value.eventId) ||

    typeof value.receivedAt !== "number" ||

    !Number.isSafeInteger(value.receivedAt) ||

    value.receivedAt <= 0 ||

    typeof value.iv !== "string" ||

    value.iv.length !== 16 ||

    typeof value.ciphertext !== "string" ||

    value.ciphertext.length < 24 ||

    value.ciphertext.length > MAX_CIPHERTEXT_LENGTH

  ) {

    throw new Error("invalid-payment-queue-envelope");

  }

  return value as PaymentQueueEnvelope;

}

export async function openPaymentQueueEvidence(

  input: unknown,

  resolveKey: PaymentQueueKeyResolver,

): Promise<PaymentQueueEvidence> {

  const envelope = validateEnvelope(input);

  const key = await resolveKey(envelope.keyId);

  const iv = decodeBase64(envelope.iv);

  if (iv.byteLength !== 12) {

    throw new Error("invalid-payment-queue-iv");

  }

  const plaintext = await crypto.subtle.decrypt(

    {

      name: "AES-GCM",

      iv,

      additionalData: associatedData(envelope),

      tagLength: 128,

    },

    key,

    decodeBase64(envelope.ciphertext),

  );

  const evidence = JSON.parse(

    decoder.decode(plaintext),

  ) as PaymentQueueEvidence;

  validateEvidence(evidence);

  return evidence;

}

export async function enqueuePaymentEvidence(

  producer: PaymentQueueProducer,

  evidence: PaymentQueueEvidence,

  keyId: string,

  key: CryptoKey,

): Promise<{ eventId: string }> {

  const envelope = await sealPaymentQueueEvidence(

    evidence,

    keyId,

    key,

  );

  // Queue persistence must succeed before the
  // caller considers the evidence durably retained.

  await producer.send(envelope);

  return { eventId: envelope.eventId };

}

export function paymentQueueRetryDelay(

  attempts: number,

): number {

  const normalized = Number.isFinite(attempts)

    ? Math.max(1, Math.floor(attempts))

    : 1;

  return Math.min(

    3600,

    5 * Math.pow(2, Math.min(normalized - 1, 10)),

  );

}

export async function consumePaymentTransportBatch(

  batch: PaymentQueueBatch,

  resolveKey: PaymentQueueKeyResolver,

  forward: (

    evidence: PaymentQueueEvidence,

  ) => Promise<Response>,

  concurrency = 4,

) {

  if (

    !Number.isInteger(concurrency) ||

    concurrency < 1 ||

    concurrency > 10

  ) {

    throw new Error("invalid-payment-transport-concurrency");

  }

  const totals = {

    received: batch.messages.length,

    completed: 0,

    retried: 0,

    unresolved: 0,

  };

  let cursor = 0;

  async function worker() {

    while (cursor < batch.messages.length) {

      const message = batch.messages[cursor++];

      if (!message) return;

      try {

        const evidence = await openPaymentQueueEvidence(

          message.body,

          resolveKey,

        );

        const response = await forward(evidence);

        if (!response.ok) {

          throw new Error("payment-forward-unconfirmed");

        }

        const result: unknown = await response.json();

        if (

          !result ||

          typeof result !== "object" ||

          (result as Record<string, unknown>)["ResultCode"] !== 0

        ) {

          throw new Error("payment-acknowledgement-unconfirmed");

        }

        message.ack();

        totals.completed++;

      } catch {

        // Never acknowledge uncertain settlement.
        // Cloudflare retry and dead-letter policies
        // retain the original encrypted evidence.

        try {

          message.retry({

            delaySeconds: paymentQueueRetryDelay(

              message.attempts,

            ),

          });

          totals.retried++;

        } catch {

          totals.unresolved++;

        }

      }

    }

  }

  await Promise.all(

    Array.from(

      {

        length: Math.min(

          concurrency,

          batch.messages.length,

        ),

      },

      () => worker(),

    ),

  );

  return totals;

}
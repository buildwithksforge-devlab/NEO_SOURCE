import {
  importPaymentQueueKey,
} from "./payment-queue-transport.server";

export interface PaymentQueueReadiness {
  transportReady: boolean;
  activationAllowed: boolean;
  activeKeyAvailable: boolean;
  registeredTokens: number;
  registeredKeys: number;
  producerAvailable: boolean;
  managedAuthorityAvailable: boolean;
  blockers: string[];
}

export async function generatePaymentQueueKey(): Promise<string> {

  const bytes = crypto.getRandomValues(
    new Uint8Array(32),
  );

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);

}

export async function hashPaymentCallbackToken(
  token: string,
): Promise<string> {

  if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) {
    throw new Error("invalid-callback-token");
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );

  return Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2,"0"),
  ).join("");

}

export async function validatePaymentQueueConfiguration(
  runtime: Record<string, unknown>,
): Promise<PaymentQueueReadiness> {

  const blockers: string[] = [];

  let registeredTokens = 0;
  let registeredKeys = 0;
  let activeKeyAvailable = false;

  const producer = runtime["NEO_PAYMENT_QUEUE"] as
    { send?: unknown } | undefined;

  const producerAvailable =
    !!producer &&
    typeof producer.send === "function";

  if (!producerAvailable) {
    blockers.push("payment-producer-unavailable");
  }

  const managedAuthorityAvailable =
    runtime["NEO_LOVABLE_BRIDGE_ENABLED"] === "true" &&
    runtime["NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED"] === "true";

  if (!managedAuthorityAvailable) {
    blockers.push("managed-payment-authority-unavailable");
  }

  try {

    const raw = runtime["NEO_PAYMENT_CALLBACK_TOKEN_HASHES"];

    if (
      typeof raw !== "string" ||
      raw.length > 100000
    ) {
      throw new Error("invalid-token-registry");
    }

    const values: unknown = JSON.parse(raw);

    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > 1000 ||
      !values.every(
        value =>
          typeof value === "string" &&
          /^[a-f0-9]{64}$/i.test(value),
      )
    ) {
      throw new Error("invalid-token-registry");
    }

    const unique = new Set(
      values.map(value => String(value).toLowerCase()),
    );

    if (unique.size !== values.length) {
      throw new Error("duplicate-token-registry");
    }

    registeredTokens = unique.size;

  } catch {

    blockers.push("invalid-callback-token-registry");

  }

  try {

    const raw = runtime["NEO_PAYMENT_QUEUE_KEYS"];

    if (
      typeof raw !== "string" ||
      raw.length > 65536
    ) {
      throw new Error("invalid-key-registry");
    }

    const registry: unknown = JSON.parse(raw);

    if (
      !registry ||
      typeof registry !== "object" ||
      Array.isArray(registry)
    ) {
      throw new Error("invalid-key-registry");
    }

    const entries = Object.entries(registry);

    if (
      entries.length < 1 ||
      entries.length > 32
    ) {
      throw new Error("invalid-key-registry");
    }

    const seenKeys = new Set<string>();

    for (const [id, value] of entries) {

      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
        typeof value !== "string"
      ) {
        throw new Error("invalid-key-entry");
      }

      const decoded = atob(value);

      if (seenKeys.has(decoded)) {
        throw new Error("duplicate-key-material");
      }

      seenKeys.add(decoded);

      await importPaymentQueueKey(value);

    }

    registeredKeys = entries.length;

    const active = runtime["NEO_PAYMENT_QUEUE_ACTIVE_KEY"];

    activeKeyAvailable =
      typeof active === "string" &&
      Object.prototype.hasOwnProperty.call(
        registry,
        active,
      );

    if (!activeKeyAvailable) {
      blockers.push("active-payment-key-unavailable");
    }

  } catch {

    blockers.push("invalid-payment-key-registry");

  }

  const transportReady = blockers.length === 0;

  // Transport readiness does not establish verified
  // financial settlement or authorize live activation.

  blockers.push("managed-financial-verification-required");

  return {

    transportReady,

    activationAllowed: false,

    activeKeyAvailable,

    registeredTokens,

    registeredKeys,

    producerAvailable,

    managedAuthorityAvailable,

    blockers,

  };

}

export async function rotatePaymentQueueKeyRegistry(

  existing: Record<string, string>,

  nextKeyId: string,

): Promise<{
  activeKeyId: string;
  keys: Record<string,string>;
}> {

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(nextKeyId)) {
    throw new Error("invalid-next-payment-key-id");
  }

  if (
    Object.prototype.hasOwnProperty.call(
      existing,
      nextKeyId,
    )
  ) {
    throw new Error("payment-key-id-already-exists");
  }

  if (Object.keys(existing).length >= 32) {
    throw new Error("payment-key-registry-capacity");
  }

  const existingKeyMaterial = new Set<string>();

  for (const [id,value] of Object.entries(existing)) {

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error("invalid-existing-payment-key-id");
    }


    const decoded = atob(value);

    if (existingKeyMaterial.has(decoded)) {
      throw new Error("duplicate-existing-payment-key-material");
    }

    existingKeyMaterial.add(decoded);

    await importPaymentQueueKey(value);

  }

  const next = await generatePaymentQueueKey();

  return {

    activeKeyId: nextKeyId,

    // Never discard older keys automatically.
    // Existing queued evidence may still require them.

    keys: {
      ...existing,
      [nextKeyId]: next,
    },

  };

}
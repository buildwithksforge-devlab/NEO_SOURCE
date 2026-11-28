import type { CallbackAdmin } from "./mpesa-callback-processing.server";

export type CallbackEnvelope = {
  provider: "mpesa";
  organizationId: string;
  eventKey: string;
  payload: Record<string, unknown>;
};

function canonicalCallbackJson(value: unknown): string {

  if (value === null) return "null";

  if (Array.isArray(value)) {

    return "[" +

      value.map(canonicalCallbackJson).join(",") +

      "]";

  }

  if (typeof value === "object") {

    const object = value as Record<string, unknown>;

    return "{" +

      Object.keys(object)

        .sort()

        .map(key =>

          JSON.stringify(key) +

          ":" +

          canonicalCallbackJson(object[key])

        )

        .join(",") +

      "}";

  }

  const serialized = JSON.stringify(value);

  if (typeof serialized !== "string") {

    throw new Error("unsupported-callback-json-value");

  }

  return serialized;
}

export async function createMpesaCallbackEnvelope(
  organizationId: string,
  payload: unknown,
): Promise<CallbackEnvelope> {

  if (
    !organizationId ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {

    throw new Error("invalid-callback-envelope");

  }

  const { readStkCallback } = await import("@/lib/mpesa.server");

  const parsed = readStkCallback(payload);

  if (
    !parsed.checkoutRequestId ||
    !Number.isInteger(parsed.resultCode)
  ) {

    throw new Error("invalid-callback-identity");

  }

  // Preserve distinct provider outcomes instead of overwriting
  // a previously received successful or unsuccessful callback.

  const identity = canonicalCallbackJson(payload);

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );

  const eventKey = Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, "0"),
  ).join("");

  return {

    provider: "mpesa",

    organizationId,

    eventKey,

    payload: payload as Record<string, unknown>,

  };
}

export async function acceptAuthenticatedCallback(
  admin: CallbackAdmin,
  envelope: CallbackEnvelope,
) {

  const { data, error } = await admin.rpc(

    "neo_payment_callback_accept",

    {

      _provider: envelope.provider,

      _endpoint_scope: envelope.organizationId,

      _event_key: envelope.eventKey,

      _payload: envelope.payload,

    },
  );

  if (
    error ||
    data?.accepted !== true ||
    typeof data.event_id !== "string"
  ) {

    throw new Error("callback-durable-acceptance-unconfirmed");

  }

  return {

    eventId: data.event_id as string,

    duplicate: data.duplicate === true,

    status: String(data.status ?? ""),

  };
}
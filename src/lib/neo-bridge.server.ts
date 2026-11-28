/**
 * NEØ local bridge.
 *
 * A separately hosted copy of this app (a local machine or the Cloudflare
 * Worker) has the public backend key but never the managed server key. For the
 * three privileged areas — M-Pesa, Staff PIN sign-in and printer computers —
 * that copy forwards the call to the live Lovable app, which runs the very same
 * handler with its own server access.
 *
 * Two independent proofs are always required:
 *   1. the shared bridge password (X-Neo-Bridge-Key) proves the call comes from
 *      the owner's own deployment;
 *   2. the caller's own credential proves who acts: the staff member's sign-in
 *      token for M-Pesa, the device token for Staff PIN, the printer-computer
 *      token for printing. The bridge password never grants identity.
 *
 * Configuration (server-only, never VITE_):
 *   live app   NEO_BRIDGE_SECRET                       → serves /api/public/bridge/*
 *   local copy NEO_BRIDGE_SECRET + NEO_BRIDGE_ORIGIN   → forwards to that origin
 */

export const BRIDGE_HEADER = "x-neo-bridge-key";
const MIN_SECRET_LENGTH = 32;
const MAX_BODY = 70_000;

/** M-Pesa server functions that may be run through the bridge. */
export const MPESA_BRIDGE_FUNCTIONS = [
  "getMpesaSettings",
  "saveMpesaSettings",
  "testMpesaConnection",
  "chargeWithMpesa",
  "reconcileMpesaTransaction",
  "chargeDeliveryWithMpesa",
  "chargeGuestFolioWithMpesa",
  "chargeGuestDepositWithMpesa",
] as const;
export type MpesaBridgeFunction = (typeof MPESA_BRIDGE_FUNCTIONS)[number];

export function isMpesaBridgeFunction(name: string): name is MpesaBridgeFunction {
  return (MPESA_BRIDGE_FUNCTIONS as readonly string[]).includes(name);
}

function secret(): string | null {
  const value = process.env["NEO_BRIDGE_SECRET"] ?? "";
  return value.length >= MIN_SECRET_LENGTH ? value : null;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time comparison over equal-length digests (no length leak). */
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Live side: is this request carrying the shared bridge password? */
export async function checkBridgeKey(
  request: Request,
): Promise<"ok" | "unconfigured" | "invalid"> {
  const expected = secret();
  if (!expected) return "unconfigured";
  const provided = request.headers.get(BRIDGE_HEADER) ?? "";
  if (!provided) return "invalid";
  return (await same(provided, expected)) ? "ok" : "invalid";
}

export function bridgeRefusal(state: "unconfigured" | "invalid"): Response {
  return Response.json(
    { error: state === "unconfigured" ? "bridge_not_configured" : "bridge_unauthorized" },
    { status: state === "unconfigured" ? 503 : 401, headers: { "Cache-Control": "no-store" } },
  );
}

export type BridgeTarget = { origin: string; secret: string };

/**
 * Local side: where to forward, or null when this deployment runs the work
 * itself (the live app). A request that already came through a bridge is never
 * forwarded again, so two misconfigured deployments cannot loop.
 */
export function bridgeTarget(incoming?: Request | null): BridgeTarget | null {
  const key = secret();
  const raw = (process.env["NEO_BRIDGE_ORIGIN"] ?? "").trim().replace(/\/+$/, "");
  if (!key || !raw) return null;
  let origin: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    origin = url.origin;
  } catch {
    return null;
  }
  if (incoming) {
    if (incoming.headers.get(BRIDGE_HEADER)) return null;
    try {
      if (new URL(incoming.url).origin === origin) return null;
    } catch {
      /* relative or missing URL: keep forwarding */
    }
  }
  return { origin, secret: key };
}

async function currentRequest(): Promise<Request | null> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    return getRequest() ?? null;
  } catch {
    return null;
  }
}

/** Reads a request body with a hard size cap. */
export async function readCapped(request: Request, cap = MAX_BODY): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > cap) return null;
  const text = await request.text();
  return text.length > cap ? null : text;
}

/**
 * Forwards a raw HTTP call (Staff PIN, printer computer) to the live bridge.
 * Only the named headers travel; cookies and the caller's origin never do.
 */
export async function forwardRaw(
  target: BridgeTarget,
  path: string,
  request: Request,
  passHeaders: string[],
): Promise<Response> {
  const body = await readCapped(request);
  if (body === null) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const headers = new Headers({ [BRIDGE_HEADER]: target.secret });
  for (const name of passHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(`${target.origin}${path}`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return Response.json({ error: "bridge_unavailable" }, { status: 502 });
    }
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "bridge_unavailable" }, { status: 502 });
  }
}

/**
 * Local side of an M-Pesa server function: when this deployment is a bridged
 * copy, run the function on the live app as the same signed-in staff member and
 * return its result. Returns null when the work should run here.
 */
export async function runMpesaViaBridge(
  name: string,
  data: unknown,
): Promise<{ result: unknown } | null> {
  const request = await currentRequest();
  const target = bridgeTarget(request);
  if (!target) return null;
  if (!isMpesaBridgeFunction(name)) throw new Error(`${name} cannot run through the bridge.`);
  const authorization = request?.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new Error("Unauthorized: sign in again.");
  let upstream: Response;
  try {
    upstream = await fetch(`${target.origin}/api/public/bridge/mpesa/${name}`, {
      method: "POST",
      headers: {
        [BRIDGE_HEADER]: target.secret,
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: data ?? null }),
      redirect: "manual",
    });
  } catch {
    throw new Error("The live NEØ app could not be reached for this M-Pesa action. Nothing was sent.");
  }
  let payload: { result?: unknown; error?: string } = {};
  try {
    payload = (await upstream.json()) as typeof payload;
  } catch {
    payload = {};
  }
  if (!upstream.ok) {
    if (upstream.status === 401 && payload.error === "bridge_unauthorized") {
      throw new Error("The live NEØ app refused the bridge password. Check NEO_BRIDGE_SECRET on both sides.");
    }
    if (upstream.status === 503 && payload.error === "bridge_not_configured") {
      throw new Error("The live NEØ app has no bridge password set yet.");
    }
    throw new Error(payload.error || `The live NEØ app answered ${upstream.status}.`);
  }
  return { result: payload.result ?? null };
}

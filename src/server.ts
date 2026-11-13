import { protectDynamicResponse } from "./lib/web-response-policy";
import { forwardManagedMpesaCallback } from "./lib/mpesa-callback-relay";
import { managedRequestDeadline, managedTransportFailure } from "./lib/managed-request-deadline";
import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

const LOVABLE_ORIGIN = "https://horizon-prime-os.lovable.app";
// These production IDs were compared with Horizon's public client on 13 Nov.
// This is an allowlist of operations, never an arbitrary URL/database proxy.
const LOVABLE_MPESA_FUNCTIONS = new Map([
  // Guest handlers are present in the supplied export 25 and retain scoped DB starts.
  ["1ef9d0260286ca208a4e39b86f242b97adf2a388b6d780f95a36143e976bc18c", "payment"],
  ["1029e96261143a6cd861d02888c8ee3c2f5ec1654855449940497f839f6bf169", "payment"],
  ["a298d96ac388c4c939b606b376547f88b23dbf95f9c193d59a8926c1baf2f8c0", "settings"],
  ["ad043ee140ba978f053a297c76e78345643b42f3bfd28eee8ad60f618cde9855", "connection"],
  ["9da0afc433195f41243eb2d86b167de79fb5b2707cfbb1bda8088afd3d76f3fd", "payment"],
  ["e9409f285f66cf784b5c66c6197de83b3e7845953b5d207a0bea88432d90af1a", "payment"],
  ["8f1dadac4fa9729e857403dafc8ef4d24a22bce0247595af2eebe91e4b203fc1", "payment"],
]);

/** Optional production relay; the original handler still verifies JWT/tenant/permission. */
export async function forwardLovableMpesaRequest(
  request: Request,
  runtime: Record<string, unknown> = {},
  upstreamFetch: typeof fetch = fetch,
): Promise<Response | null> {
  const setting = (name: string) => runtime[name] ?? process.env[name];
  if (setting("NEO_LOVABLE_BRIDGE_ENABLED") !== "true") return null;
  const url = new URL(request.url);
  // The same source can run on both hosts without forwarding back to itself.
  if (url.origin === LOVABLE_ORIGIN) return null;
  const id = /^\/_serverFn\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  const operation = id ? LOVABLE_MPESA_FUNCTIONS.get(id) : undefined;
  if (!operation) return null;
  const fail = (message: string, status: number) =>
    // Unserialized JSON errors are treated as values by the framework client.
    // Plain-text non-2xx responses become errors instead of false successes.
    protectDynamicResponse(
      new Response(message, {
        status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  if (request.method !== "POST") return fail("This operation requires POST.", 405);
  if (url.search) return fail("Query parameters are not supported by this relay.", 400);
  if (
    (request.headers.has("origin") && request.headers.get("origin") !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return fail("Cross-site payment requests are not permitted.", 403);
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) {
    return fail("Sign in before using this operation.", 401);
  }
  // The remote code cannot be assumed to include this checkout's dispatch and
  // callback repairs. Enabling transport alone must never enable collections.
  if (operation === "payment" && setting("NEO_LOVABLE_BRIDGE_PAYMENTS_ENABLED") !== "true") {
    return fail(
      "Payment forwarding is not enabled. Verify the original backend payment safeguards and callback contract first.",
      503,
    );
  }
  if (operation === "payment" && setting("NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED") !== "true") {
    return fail("Payment callbacks must be routed to the managed backend before forwarding collections.", 503);
  }
  const contentType = request.headers.get("content-type");
  if (contentType && contentType.split(";")[0]?.trim() !== "application/json") {
    return fail("Only JSON server-function requests are supported.", 415);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32768) {
          await reader.cancel();
          return fail("Request is too large.", 413);
        }
        chunks.push(value);
      }
    }
  } catch {
    return fail("The request body could not be read.", 400);
  } finally {
    reader?.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers({
    Authorization: authorization,
    Origin: LOVABLE_ORIGIN,
    "x-tsr-serverFn": "true",
  });
  for (const name of ["accept", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const deadline = managedRequestDeadline(request.signal);
  try {
    const upstream = await upstreamFetch.call(globalThis, `${LOVABLE_ORIGIN}${url.pathname}`, {
      method: "POST",
      headers,
      body: size ? body : null,
      redirect: "manual",
      signal: deadline.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return fail("The original backend returned an unexpected redirect.", 502);
    }
    if (!upstream.ok && !upstream.headers.has("x-tss-serialized")) {
      return fail(
        `The original backend rejected this request (HTTP ${upstream.status}). Check its authentication and existing attempt before retrying.`,
        upstream.status,
      );
    }
    if (!(upstream.headers.get("content-type") ?? "").match(/json|ndjson|x-tss/i)) {
      return fail("The original backend returned an incompatible response.", 502);
    }
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("set-cookie");
    responseHeaders.delete("access-control-allow-origin");
    return protectDynamicResponse(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      }),
    );
  } catch (error) {
    console.error("Managed M-Pesa transport failed", managedTransportFailure(error));
    // Never retry/fall back to local dispatch: the original may have accepted it.
    return fail(
      "The original backend response was not received. Check the existing attempt before retrying; no automatic retry was made.",
      502,
    );
  } finally {
    deadline.dispose();
  }
}

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const callback = await forwardManagedMpesaCallback(
        request,
        env && typeof env === "object" ? (env as Record<string, unknown>) : {},
      );
      if (callback) return callback;
      const forwarded = await forwardLovableMpesaRequest(
        request,
        env && typeof env === "object" ? (env as Record<string, unknown>) : {},
      );
      if (forwarded) return forwarded;
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return protectDynamicResponse(await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return protectDynamicResponse(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
  },
};

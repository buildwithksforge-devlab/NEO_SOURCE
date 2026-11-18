import { managedRequestDeadline, managedTransportFailure } from "./managed-request-deadline";
import { protectDynamicResponse } from "./web-response-policy";
const ORIGIN = "https://horizon-prime-os.lovable.app";
// Compared with Horizon's public client on 18 Nov. IDs identify routes, not
// installed implementation/authority parity. Activation remains separately gated.
export const MANAGED_SERVICE_OPERATIONS = new Map([
  [
    "e98b312a6ceb488a8c655879fd1294414c8ca3f5371063378ad309e1c8c1f433",
    { name: "getProviderCredentialSummary", group: "comms", action: false },
  ],
  [
    "81f843f81acb23ef4b7e0b1745c4b027d50ee4d4513edc8819194a263993f75a",
    { name: "refreshProviderStatus", group: "comms", action: true },
  ],
  [
    "7c577048a3d8c6a886f516c40e626289dc77884a0cca29c57c32d3c2fb44e8ec",
    { name: "saveProviderSender", group: "comms", action: true },
  ],
  [
    "e1a8239fdb50975be4b258d94aee8d80ed2e30aa503f2f48b599ef140c0e7c94",
    { name: "sendProcurementDeliveryReminders", group: "comms", action: true },
  ],
  [
    "32bd4c986b8e1dfc7931b605cc9ae4d0de993a9310f3f16d5d5d7e4a976714f2",
    { name: "runAutomationEngine", group: "comms", action: true },
  ],
  [
    "e20a8cc2029e48b65ffca78a63d8472ccb9ff62eb7116120637621a56ed95c3f",
    { name: "resetStaffPassword", group: "users", action: true },
  ],
  [
    "b6ebab684d537948ca21b93e8e2e13fe897e2ece52683e5f75d6dad375ade8ae",
    { name: "requireStaffPasswordChange", group: "users", action: true },
  ],
]);

/** Existing scoped server functions only. No generic SQL/provider/key proxy. */
export async function forwardManagedServiceRequest(
  request: Request,
  runtime: Record<string, unknown> = {},
  upstreamFetch: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.origin === ORIGIN) return null;
  const id = /^\/_serverFn\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  const operation = id ? MANAGED_SERVICE_OPERATIONS.get(id) : undefined;
  if (!operation) return null;
  const requestEnv = (
    request as Request & { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }
  ).runtime?.cloudflare?.env;
  const setting = (key: string) => runtime[key] ?? requestEnv?.[key] ?? process.env[key];
  const gate =
    operation.group === "users" ? "NEO_MANAGED_USERS_ENABLED" : "NEO_MANAGED_COMMS_ENABLED";
  if (setting(gate) !== "true") return null;
  const fail = (status: number, message: string) =>
    protectDynamicResponse(
      new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
  if (request.method !== "POST") return fail(405, "This operation requires POST.");
  if (url.search)
    return fail(400, "Query parameters are not supported for this managed operation.");
  if (
    (request.headers.has("origin") && request.headers.get("origin") !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return fail(403, "Cross-site administration requests are not permitted.");
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization))
    return fail(401, "Sign in before using this operation.");
  // A host switch must not release old communications or change account access
  // just because a readiness/settings check starts working.
  if (
    operation.group === "comms" &&
    operation.action &&
    setting("NEO_MANAGED_COMMS_ACTIONS_ENABLED") !== "true"
  )
    return fail(
      503,
      "Managed communication actions are not enabled. Verify the original provider, scope and reviewed outbound cutoff first.",
    );
  if (operation.group === "users" && setting("NEO_MANAGED_USERS_ACTIONS_ENABLED") !== "true")
    return fail(
      503,
      "Managed account changes are not enabled. Verify the original account authority and audit contract first.",
    );
  const contentType = request.headers.get("content-type");
  if (contentType && contentType.split(";")[0]?.trim() !== "application/json")
    return fail(415, "Only JSON server-function requests are supported.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  try {
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32768) {
          await reader.cancel();
          return fail(413, "Request is too large.");
        }
        chunks.push(value);
      }
  } catch {
    return fail(400, "The request body could not be read.");
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
    Origin: ORIGIN,
    "x-tsr-serverFn": "true",
  });
  for (const name of ["accept", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const deadline = managedRequestDeadline(request.signal);
  try {
    const upstream = await upstreamFetch.call(globalThis, `${ORIGIN}/_serverFn/${id}`, {
      method: "POST",
      headers,
      body: size ? body : null,
      redirect: "manual",
      signal: deadline.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400)
      return fail(502, "The managed backend returned an unexpected redirect.");
    if (!upstream.ok && !upstream.headers.has("x-tss-serialized"))
      return fail(
        upstream.status,
        "The managed backend rejected this operation. Check the existing message/account history before retrying.",
      );
    if (!(upstream.headers.get("content-type") ?? "").match(/json|ndjson|x-tss/i))
      return fail(502, "The managed backend returned an incompatible response.");
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("set-cookie");
    responseHeaders.delete("access-control-allow-origin");
    return protectDynamicResponse(
      new Response(upstream.body, { status: upstream.status, headers: responseHeaders }),
    );
  } catch (error) {
    console.error("Managed service transport failed", managedTransportFailure(error));
    return fail(
      503,
      "The managed response was not received. Check the existing message/account history; no automatic retry or local fallback was made.",
    );
  } finally {
    deadline.dispose();
  }
}

import { protectDynamicResponse } from "./web-response-policy";
import { managedRequestDeadline, managedTransportFailure } from "./managed-request-deadline";

const MANAGED_ORIGIN = "https://horizon-prime-os.lovable.app";

/** Forward only the existing token-authenticated callback; never execute locally in bridge mode. */
export async function forwardManagedMpesaCallback(
  request: Request,
  runtime: Record<string, unknown> = {},
  upstreamFetch: typeof fetch = fetch,
): Promise<Response | null> {
  const setting = (name: string) => runtime[name] ?? process.env[name];
  if (setting("NEO_LOVABLE_BRIDGE_ENABLED") !== "true") return null;
  const url = new URL(request.url);
  if (url.origin === MANAGED_ORIGIN || !url.pathname.startsWith("/api/public/mpesa/callback/")) return null;
  const fail = (status: number, message: string) => protectDynamicResponse(new Response(message, { status }));
  // Separate from initiation: callbacks must remain deliverable when new collections are paused.
  if (setting("NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED") !== "true") {
    return fail(503, "Managed payment callback forwarding is not enabled.");
  }
  if (!/^\/api\/public\/mpesa\/callback\/[A-Za-z0-9_-]{16,256}$/.test(url.pathname) || url.search) {
    return fail(400, "Invalid callback address.");
  }
  if (request.method !== "POST") return fail(405, "This callback requires POST.");
  if ((request.headers.get("content-type") ?? "").split(";")[0]?.trim() !== "application/json") {
    return fail(415, "This callback requires JSON.");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        return fail(413, "Callback is too large.");
      }
      chunks.push(value);
    }
  } catch {
    return fail(400, "Callback body could not be read.");
  } finally {
    reader?.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    JSON.parse(new TextDecoder().decode(body));
  } catch {
    return fail(400, "Invalid callback JSON.");
  }
  const deadline = managedRequestDeadline(request.signal);
  try {
    const response = await upstreamFetch.call(globalThis, `${MANAGED_ORIGIN}${url.pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      redirect: "manual",
      signal: deadline.signal,
    });
    // The managed handler validates the tenant token, checkout, provider result and atomic posting.
    // Never manufacture an ACK or return backend errors containing internal details.
    if (!response.ok) return fail(response.status >= 400 ? response.status : 502, "Managed callback was not accepted.");
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
      return fail(502, "Managed callback returned an invalid acknowledgement.");
    }
    const ack: unknown = await response.json();
    if (!ack || typeof ack !== "object" || Array.isArray(ack) || !("ResultCode" in ack) || ack.ResultCode !== 0) {
      return fail(502, "Managed callback did not acknowledge this result.");
    }
    return protectDynamicResponse(Response.json({ ResultCode: 0, ResultDesc: "Accepted" }));
  } catch (error) {
    console.error("Managed M-Pesa callback transport failed", managedTransportFailure(error));
    // No retry or local fallback: upstream may already have committed the result.
    return fail(503, "Managed callback response is unavailable. Keep this result unresolved.");
  } finally {
    deadline.dispose();
  }
}

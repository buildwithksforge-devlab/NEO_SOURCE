import { fromCrossJSON, toJSONAsync } from "seroval";
import { managedRequestDeadline } from "./managed-request-deadline";

const ORIGIN = "https://horizon-prime-os.lovable.app";
const CONNECTION = "ad043ee140ba978f053a297c76e78345643b42f3bfd28eee8ad60f618cde9855";
type ConnectionResult = { authorised?: boolean; ok?: boolean; status?: string; detail?: string; environment?: string };

/** Reuse the existing managed connection command after the local caller's authority check. */
export async function testManagedSavedMpesaConnection(request: Request, transport: typeof fetch = fetch): Promise<ConnectionResult> {
  const authorization = request.headers.get("authorization") || "";
  if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) throw Error("Sign in before testing M-Pesa.");
  const deadline = managedRequestDeadline(request.signal);
  try {
    const response = await transport.call(globalThis, `${ORIGIN}/_serverFn/${CONNECTION}`, {
      method: "POST", headers: { Authorization: authorization, Origin: ORIGIN,
        "Content-Type": "application/json", Accept: "application/json", "x-tsr-serverFn": "true" },
      body: JSON.stringify(await toJSONAsync({ data: {} })), redirect: "manual", signal: deadline.signal,
    });
    if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) throw Error("Managed connection check was not accepted.");
    const reader = response.body?.getReader(); if (!reader) throw Error("Managed connection result is missing.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
        if (size > 65536) { await reader.cancel(); throw Error("Managed connection result is too large."); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    const envelope = fromCrossJSON(JSON.parse(new TextDecoder().decode(bytes)), {}) as { result?: ConnectionResult; error?: unknown };
    if (envelope.error || !envelope.result || typeof envelope.result !== "object" || envelope.result.authorised !== true) throw Error("Managed M-Pesa connection authority was not confirmed.");
    return envelope.result;
  } finally { deadline.dispose(); }
}

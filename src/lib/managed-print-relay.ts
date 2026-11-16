import { managedRequestDeadline, managedTransportFailure } from "./managed-request-deadline";
import { protectDynamicResponse } from "./web-response-policy";

const ORIGIN = "https://horizon-prime-os.lovable.app";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["printers", "claim", "finish", "discovery", "discovered"]);
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const uuid = (value: unknown) => typeof value === "string" && UUID.test(value);
const fail = (status: number, error: string) =>
  protectDynamicResponse(Response.json({ error }, { status }));

/** Use the existing managed executor; never export its service key or retry a job. */
export async function forwardManagedPrintRequest(
  request: Request,
  runtime: Record<string, unknown> = {},
  upstreamFetch: typeof fetch = fetch,
): Promise<Response | null> {
  // Nitro's Cloudflare adapter invokes the SSR service with only Request.
  // Read its request-local binding, never the shared global __env__ value.
  const requestEnv = (
    request as Request & { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }
  ).runtime?.cloudflare?.env;
  if (
    (runtime["NEO_MANAGED_PRINT_ENABLED"] ??
      requestEnv?.["NEO_MANAGED_PRINT_ENABLED"] ??
      process.env["NEO_MANAGED_PRINT_ENABLED"]) !== "true"
  )
    return null;
  const url = new URL(request.url);
  if (url.origin === ORIGIN || !url.pathname.startsWith("/api/public/print-agent/")) return null;
  const action = /^\/api\/public\/print-agent\/([a-z]+)$/.exec(url.pathname)?.[1];
  if (!action || !ACTIONS.has(action)) return fail(404, "unknown_print_action");
  if (url.search) return fail(400, "invalid_print_address");
  if (request.method !== "POST") return fail(405, "post_required");
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer neopc_[0-9a-f]{64}$/.test(authorization)) return fail(401, "unauthorized");
  const contentType = request.headers.get("content-type");
  if (contentType && contentType.split(";")[0]?.trim() !== "application/json")
    return fail(415, "json_required");
  const maxBytes = action === "discovered" ? 64000 : 4096;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  try {
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          return fail(413, "payload_too_large");
        }
        chunks.push(value);
      }
  } catch {
    return fail(400, "invalid_json");
  } finally {
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let input: unknown;
  try {
    input = size ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch {
    return fail(400, "invalid_json");
  }
  if (!object(input)) return fail(400, "invalid_json");
  // Forward only the existing action fields, not an arbitrary database command.
  let body: Record<string, unknown> = {};
  if (action === "claim") {
    if (!uuid(input["printer_id"])) return fail(400, "invalid_printer");
    body = { printer_id: input["printer_id"] };
  } else if (action === "finish") {
    if (
      !uuid(input["job_id"]) ||
      !uuid(input["claim_id"]) ||
      !["completed", "not_printed", "outcome_unknown"].includes(String(input["outcome"]))
    )
      return fail(400, "invalid_input");
    body = {
      job_id: input["job_id"],
      claim_id: input["claim_id"],
      outcome: input["outcome"],
      error: input["error"] == null ? null : String(input["error"]).slice(0, 1000),
    };
  } else if (action === "discovered") {
    if (!uuid(input["request_id"]) || !object(input["result"])) return fail(400, "invalid_input");
    body = { request_id: input["request_id"], result: input["result"] };
  }
  const deadline = managedRequestDeadline(request.signal);
  try {
    const upstream = await upstreamFetch.call(
      globalThis,
      `${ORIGIN}/api/public/print-agent/${action}`,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: deadline.signal,
      },
    );
    if (upstream.status >= 300 && upstream.status < 400)
      return fail(502, "managed_print_redirect_rejected");
    if (!upstream.ok)
      return fail(
        [400, 401, 403, 409, 413].includes(upstream.status) ? upstream.status : 503,
        "managed_print_request_rejected",
      );
    if (!(upstream.headers.get("content-type") ?? "").includes("application/json"))
      return fail(502, "invalid_managed_print_response");
    const result: unknown = await upstream.json();
    if (!object(result)) return fail(502, "invalid_managed_print_response");
    const valid =
      action === "printers"
        ? Array.isArray(result["printers"]) &&
          result["printers"].every((p) => object(p) && uuid(p["id"]))
        : action === "claim"
          ? result["job"] === null ||
            (object(result["job"]) &&
              uuid(result["job"]["job_id"]) &&
              uuid(result["job"]["claim_id"]))
          : action === "discovery"
            ? result["request"] === null ||
              (object(result["request"]) &&
                uuid(result["request"]["request_id"]) &&
                ["network", "windows", "usb", "bluetooth"].includes(
                  String(result["request"]["kind"]),
                ))
            : action === "discovered"
              ? result["ok"] === true
              : object(result["status"]) &&
                ["completed", "queued", "failed"].includes(String(result["status"]["status"]));
    if (!valid) return fail(502, "invalid_managed_print_response");
    return protectDynamicResponse(Response.json(result));
  } catch (error) {
    console.error("Managed print transport failed", managedTransportFailure(error));
    // A claim or finish may already have committed. The agent's existing
    // delivery journal/claim expiry owns recovery; no local execution fallback.
    return fail(503, "managed_print_response_unavailable_check_queue");
  } finally {
    deadline.dispose();
  }
}

import { createFileRoute } from "@tanstack/react-router";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOMES = new Set(["completed", "not_printed", "outcome_unknown"]);

async function sha256Hex(value: string) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export const Route = createFileRoute("/api/public/print-agent/$action")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const authorization = request.headers.get("authorization") ?? "";

        const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";

        if (!/^neopc_[0-9a-f]{64}$/.test(token)) {
          return response({ error: "unauthorized" }, 401);
        }

        let body: Record<string, unknown> = {};

        try {
          const raw = await request.text();

          if (
            new TextEncoder().encode(raw).length > (params.action === "discovered" ? 64000 : 4096)
          ) {
            return response({ error: "payload_too_large" }, 413);
          }

          body = raw ? JSON.parse(raw) : {};

          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return response({ error: "invalid_json" }, 400);
          }
        } catch {
          return response({ error: "invalid_json" }, 400);
        }

        const hash = await sha256Hex(token);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const database = supabaseAdmin as unknown as {
          rpc: (
            name: string,
            args: Record<string, unknown>,
          ) => Promise<{
            data: unknown;
            error: { message: string } | null;
          }>;
        };

        const handleError = (message: string) => {
          if (/unauthorized|invalid_print_agent_token/i.test(message)) {
            return response({ error: "unauthorized" }, 401);
          }

          if (
            /scope|Invalid or expired|invalid_or_stale_print_claim|invalid_or_stale_discovery_request|printer_not_available_to_agent/i.test(
              message,
            )
          ) {
            return response({ error: "claim_conflict" }, 409);
          }

          return response({ error: "server_error" }, 500);
        };

        if (params.action === "printers") {
          const { data, error } = await database.rpc("neo_print_agent_printers", {
            _token_hash: hash,
          });

          if (error) return handleError(error.message);

          return response({ printers: data ?? [] });
        }

        if (params.action === "claim") {
          const printer = String(body["printer_id"] ?? "");

          if (!UUID.test(printer)) {
            return response({ error: "invalid_printer" }, 400);
          }

          const { data, error } = await database.rpc("neo_print_agent_claim", {
            _token_hash: hash,
            _printer: printer,
          });

          if (error) return handleError(error.message);

          const job = data as Record<string, unknown> | null;

          if (
            job !== null &&
            (!job ||
              Array.isArray(job) ||
              !UUID.test(String(job["job_id"] ?? "")) ||
              !UUID.test(String(job["claim_id"] ?? "")))
          ) {
            return response({ error: "invalid_database_response" }, 502);
          }
          return response({ job });
        }

        if (params.action === "finish") {
          const job = String(body["job_id"] ?? "");
          const claim = String(body["claim_id"] ?? "");
          const outcome = String(body["outcome"] ?? "");

          if (!UUID.test(job) || !UUID.test(claim) || !OUTCOMES.has(outcome)) {
            return response({ error: "invalid_input" }, 400);
          }

          const errorText = body["error"] == null ? null : String(body["error"]).slice(0, 1000);

          const { data, error } = await database.rpc("neo_print_agent_finish", {
            _token_hash: hash,
            _job: job,
            _claim: claim,
            _outcome: outcome,
            _error: errorText,
          });

          if (error) return handleError(error.message);

          const result = data as Record<string, unknown> | null;
          if (!result || !["completed", "queued", "failed"].includes(String(result["status"]))) {
            return response({ error: "invalid_database_response" }, 502);
          }
          return response({ status: data });
        }

        if (params.action === "discovery") {
          const { data, error } = await database.rpc("neo_print_agent_discovery_poll", {
            _token_hash: hash,
          });
          if (error) return handleError(error.message);
          return response({ request: data });
        }
        if (params.action === "discovered") {
          const id = String(body["request_id"] ?? "");
          const result = body["result"];
          if (!UUID.test(id) || !result || typeof result !== "object" || Array.isArray(result))
            return response({ error: "invalid_input" }, 400);
          const { data, error } = await database.rpc("neo_print_agent_discovery_report", {
            _token_hash: hash,
            _request: id,
            _result: result,
          });
          if (error) return handleError(error.message);
          if (!data || (data as Record<string, unknown>)["ok"] !== true)
            return response({ error: "invalid_database_response" }, 502);
          return response(data);
        }
        return response({ error: "not_found" }, 404);
      },
    },
  },
});

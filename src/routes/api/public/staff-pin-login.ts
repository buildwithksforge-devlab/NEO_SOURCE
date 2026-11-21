import { createFileRoute } from "@tanstack/react-router";

const DEVICE_TOKEN = /^neowd_[0-9a-f]{64}$/;
const STAFF_PIN_BROKER_URL = "https://horizon-prime-os.lovable.app/api/public/staff-pin-login";
const CLOUDFLARE_APP_ORIGIN = "https://neo-preview.neo-hospitality.workers.dev";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EdgeResponse = {
  token_hash?: string;
  branch_id?: string;
  error?: string;
  message?: string;
};

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}

function safeText(value: unknown, fallback: string, maximum = 250) {
  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value.trim();

  return cleaned.length > 0 ? cleaned.slice(0, maximum) : fallback;
}

export const Route = createFileRoute("/api/public/staff-pin-login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";

        const deviceToken = authorization.startsWith("Bearer ")
          ? authorization.slice(7).trim()
          : "";

        if (!DEVICE_TOKEN.test(deviceToken)) {
          return response(
            {
              error: "device",
              message: "This device is not authorised for staff PIN sign-in.",
            },
            401,
          );
        }

        let body: Record<string, unknown>;

        try {
          const raw = await request.text();

          if (raw.length > 256) {
            return response(
              {
                error: "invalid_request",
                message: "The sign-in request is invalid.",
              },
              400,
            );
          }

          body = raw.length > 0 ? JSON.parse(raw) : {};

          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return response(
              {
                error: "invalid_request",
                message: "The sign-in request is invalid.",
              },
              400,
            );
          }
        } catch {
          return response(
            {
              error: "invalid_request",
              message: "The sign-in request is invalid.",
            },
            400,
          );
        }

        const pin = String(body["pin"] ?? "");

        if (!/^[0-9]{6}$/.test(pin)) {
          return response(
            {
              error: "credentials",
              message: "Enter your six-digit personal PIN.",
            },
            400,
          );
        }

        const controller = new AbortController();

        const timeout = setTimeout(() => controller.abort(), 15_000);

        let upstream: Response;

        try {
          upstream = await fetch(STAFF_PIN_BROKER_URL, {
            method: "POST",
            headers: {
              Origin: CLOUDFLARE_APP_ORIGIN,
              "Content-Type": "application/json",
              "x-neo-device-token": deviceToken,
            },
            body: JSON.stringify({ pin }),
            // Do not carry a device credential/PIN to a redirect target.
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          console.error("[staff-pin-login] edge_request_failed", {
            name: error instanceof Error ? error.name.slice(0, 80) : "unknown",
          });

          return response(
            {
              error: "server_error",
              message: "Staff PIN sign-in is temporarily unavailable.",
            },
            502,
          );
        } finally {
          clearTimeout(timeout);
        }

        if (upstream.status >= 300 && upstream.status < 400) {
          return response({ error: "server_error", message: "Staff PIN sign-in is temporarily unavailable." }, 502);
        }

        let payload: EdgeResponse;

        try {
          const raw = await upstream.text();

          if (raw.length > 4096) {
            throw new Error("Oversized Edge Function response");
          }

          payload = raw.length > 0 ? JSON.parse(raw) : {};
        } catch {
          console.error("[staff-pin-login] edge_response_invalid", {
            status: upstream.status,
          });

          return response(
            {
              error: "server_error",
              message: "Staff PIN sign-in is temporarily unavailable.",
            },
            502,
          );
        }

        if (!upstream.ok) {
          return response(
            {
              error: safeText(payload.error, "server_error", 80),
              message: safeText(payload.message, "Staff PIN sign-in is temporarily unavailable."),
            },
            upstream.status,
          );
        }

        const loginToken = String(payload.token_hash ?? "");

        const branchId = String(payload.branch_id ?? "");

        if (loginToken.length === 0 || !UUID.test(branchId)) {
          console.error("[staff-pin-login] edge_contract_incomplete");

          return response(
            {
              error: "server_error",
              message: "Staff PIN sign-in is temporarily unavailable.",
            },
            502,
          );
        }

        return response({
          token_hash: loginToken,
          branch_id: branchId,
        });
      },
    },
  },
});

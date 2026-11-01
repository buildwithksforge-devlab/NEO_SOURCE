import { createFileRoute } from "@tanstack/react-router";
import { trustedRpc } from "@/lib/rpc-guard";

const DEVICE_TOKEN = /^neowd_[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResolveResult = {
  ok?: boolean;
  reason?: string;
  message?: string;
  user_id?: string;
  branch_id?: string;
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

async function sha256Hex(value: string) {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const Route = createFileRoute(
  "/api/public/staff-pin-login",
)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization =
          request.headers.get("authorization") ?? "";

        const deviceToken = authorization.startsWith("Bearer ")
          ? authorization.slice(7).trim()
          : "";

        if (!DEVICE_TOKEN.test(deviceToken)) {
          return response(
            {
              error: "device",
              message:
                "This device is not authorised for staff PIN sign-in.",
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

          body = raw ? JSON.parse(raw) : {};

          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body)
          ) {
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

        const tokenHash = await sha256Hex(deviceToken);

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        const database = supabaseAdmin as unknown as {
          rpc: (
            name: string,
            args: Record<string, unknown>,
          ) => Promise<{
            data: unknown;
            error: { message: string } | null;
          }>;
        };

        const { data, error } = await trustedRpc<ResolveResult>(
          database,
          "neo_staff_login_device_resolve",
          {
            _token_hash: tokenHash,
            _pin: pin,
          },
        );

        if (error) {
          return response(
            {
              error: "server_error",
              message:
                "Staff PIN sign-in is temporarily unavailable.",
            },
            500,
          );
        }

        const resolved = (data ?? {}) as ResolveResult;

        if (!resolved.ok) {
          const reason = resolved.reason ?? "credentials";
          const status =
            reason === "locked"
              ? 429
              : reason === "scope"
                ? 403
                : 401;

          return response(
            {
              error: reason,
              message:
                resolved.message ??
                "PIN not accepted. Check your PIN or ask your supervisor.",
            },
            status,
          );
        }

        const userId = String(resolved.user_id ?? "");
        const branchId = String(resolved.branch_id ?? "");

        if (!UUID.test(userId) || !UUID.test(branchId)) {
          return response(
            {
              error: "server_error",
              message:
                "Staff PIN sign-in is temporarily unavailable.",
            },
            500,
          );
        }

        const userResult =
          await supabaseAdmin.auth.admin.getUserById(userId);

        const email = userResult.data.user?.email;

        if (userResult.error || !email) {
          return response(
            {
              error: "account",
              message:
                "Your staff sign-in account is unavailable. Ask your supervisor for help.",
            },
            403,
          );
        }

        const linkResult =
          await supabaseAdmin.auth.admin.generateLink({
            type: "magiclink",
            email,
          });

        const loginToken =
          linkResult.data.properties?.hashed_token;

        if (linkResult.error || !loginToken) {
          return response(
            {
              error: "server_error",
              message:
                "Staff PIN sign-in is temporarily unavailable.",
            },
            500,
          );
        }

        // The employee identity and email stay server-side. The browser receives
        // only a single-use Supabase verification token and the trusted
        // property's ID.
        return response({
          token_hash: loginToken,
          branch_id: branchId,
        });
      },
    },
  },
});
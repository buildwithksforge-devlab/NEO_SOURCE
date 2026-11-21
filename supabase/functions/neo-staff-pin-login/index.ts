import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ObjectValue = Record<string, unknown>;

type ResolveResult = {
  ok?: boolean;
  reason?: string;
  message?: string;
  user_id?: string;
  branch_id?: string;
};

const DEVICE_TOKEN = /^neowd_[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  pragma: "no-cache",
};

function json(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function asObject(value: unknown): ObjectValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as ObjectValue;
}

function readDeviceToken(
  request: Request,
  body: ObjectValue,
): string {
  const explicit =
    request.headers.get("x-neo-device-token")?.trim();

  if (explicit) {
    return explicit;
  }

  if (typeof body.device_token === "string") {
    return body.device_token.trim();
  }

  const authorization =
    request.headers.get("authorization") ?? "";

  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
}

async function sha256Hex(value: string): Promise<string> {
  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return json(405, {
      error: "method",
      message: "POST is required.",
    });
  }

  const supabaseUrl =
    Deno.env.get("SUPABASE_URL")?.trim();

  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "[neo-staff-pin-login] backend_configuration_missing",
    );

    return json(503, {
      error: "server_error",
      message: "Staff PIN sign-in is temporarily unavailable.",
    });
  }

  let body: ObjectValue;

  try {
    const raw =
      await request.text();

    if (raw.length > 256) {
      return json(400, {
        error: "invalid_request",
        message: "The sign-in request is invalid.",
      });
    }

    body =
      raw.length > 0
        ? asObject(JSON.parse(raw)) ?? {}
        : {};
  } catch {
    return json(400, {
      error: "invalid_request",
      message: "The sign-in request is invalid.",
    });
  }

  const pin =
    typeof body.pin === "string"
      ? body.pin
      : "";

  const deviceToken =
    readDeviceToken(request, body);

  if (!DEVICE_TOKEN.test(deviceToken)) {
    return json(401, {
      error: "device",
      message:
        "This device is not authorised for staff PIN sign-in.",
    });
  }

  if (!/^[0-9]{6}$/.test(pin)) {
    return json(400, {
      error: "credentials",
      message: "Enter your six-digit personal PIN.",
    });
  }

  const admin =
    createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });

  const tokenHash =
    await sha256Hex(deviceToken);

  const {
    data,
    error,
  } = await admin.rpc(
    "neo_staff_login_device_resolve",
    {
      _token_hash: tokenHash,
      _pin: pin,
    },
  );

  if (error) {
    console.error(
      "[neo-staff-pin-login] resolver_failed",
      {
        code: error.code ?? "unknown",
      },
    );

    return json(500, {
      error: "server_error",
      message: "Staff PIN sign-in is temporarily unavailable.",
    });
  }

  const resolved =
    (asObject(data) ?? {}) as ResolveResult;

  if (!resolved.ok) {
    const reason =
      resolved.reason ?? "credentials";

    const status =
      reason === "locked"
        ? 429
        : reason === "scope"
          ? 403
          : 401;

    return json(status, {
      error: reason,
      message:
        resolved.message ??
        "PIN not accepted. Check your PIN or ask your supervisor.",
    });
  }

  const userId =
    String(resolved.user_id ?? "");

  const branchId =
    String(resolved.branch_id ?? "");

  if (!UUID.test(userId) || !UUID.test(branchId)) {
    console.error(
      "[neo-staff-pin-login] resolver_identity_incomplete",
    );

    return json(500, {
      error: "server_error",
      message: "Staff PIN sign-in is temporarily unavailable.",
    });
  }

  const userResult =
    await admin.auth.admin.getUserById(userId);

  const email =
    userResult.data.user?.email;

  if (userResult.error || !email) {
    console.error(
      "[neo-staff-pin-login] auth_identity_missing",
      {
        status: userResult.error?.status ?? "unknown",
      },
    );

    return json(403, {
      error: "account",
      message:
        "Your staff sign-in account is unavailable. Ask your supervisor for help.",
    });
  }

  const linkResult =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });

  const loginToken =
    linkResult.data.properties?.hashed_token;

  if (linkResult.error || !loginToken) {
    console.error(
      "[neo-staff-pin-login] login_proof_failed",
      {
        status: linkResult.error?.status ?? "unknown",
      },
    );

    return json(500, {
      error: "server_error",
      message: "Staff PIN sign-in is temporarily unavailable.",
    });
  }

  return json(200, {
    token_hash: loginToken,
    branch_id: branchId,
  });
});

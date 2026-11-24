import { trustedRpc } from "@/lib/rpc-guard";
import { createClient } from "@supabase/supabase-js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = { error: "server_error", message: "Staff PIN sign-in is temporarily unavailable." };

type Resolution = {
  ok?: boolean;
  kind?: string;
  branch_id?: string;
  display_token?: string;
  expires_at?: string;
  user_id?: string;
  reason?: string;
  message?: string;
};

export async function resolveStaffPin(request: Request, deviceToken: string, pin: string, bindings: Record<string, unknown> = {}) {
  const runtime = (request as Request & {
    runtime?: { cloudflare?: { env?: Record<string, unknown> } };
  }).runtime?.cloudflare?.env;
  const urlBinding = bindings["SUPABASE_URL"] ?? runtime?.["SUPABASE_URL"] ?? process.env["SUPABASE_URL"];
  const keyBinding = bindings["SUPABASE_SERVICE_ROLE_KEY"] ?? runtime?.["SUPABASE_SERVICE_ROLE_KEY"] ?? process.env["SUPABASE_SERVICE_ROLE_KEY"];
  const url = typeof urlBinding === "string" ? urlBinding.trim() : "";
  const key = typeof keyBinding === "string" ? keyBinding.trim() : "";
  // An installation without Worker credentials can continue using its broker.
  if (!url || !key) return null;

  const signal = AbortSignal.timeout(15_000);
  let rpcStatus: number | undefined;
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      async fetch(input, init) {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        headers.set("apikey", key);
        if (key.startsWith("sb_secret_") && headers.get("authorization") === `Bearer ${key}`) {
          headers.delete("authorization");
        }
        // Workers supports manual redirects. Never forward credentials to a redirect target.
        const response = await fetch(input, { ...init, headers, redirect: "manual", signal });
        rpcStatus = response.status;
        if (response.status >= 300 && response.status < 400) {
          throw new Error("Unexpected redirect from the PIN database endpoint");
        }
        return response;
      },
    },
  });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceToken));
  const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { data, error } = await trustedRpc<Resolution>(admin, "neo_staff_pin_sign_in", {
    _token_hash: tokenHash,
    _pin: pin,
  });
  if (error || !data) {
    const code = error?.code;
    const endpointRejected = rpcStatus === 401 || code === "PGRST202" || code === "PGRST301"
      || error?.message === "Invalid API key";
    console.error("[staff-pin-login] rpc_failed", {
      status: rpcStatus ?? null,
      code: code && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : null,
      brokerFallback: endpointRejected,
    });
    // A rejected gateway request cannot consume a database PIN attempt.
    if (endpointRejected) return null;
    return { status: 502, body: unavailable };
  }

  if (!data.ok) {
    const reason = data.reason ?? "credentials";
    return {
      status: reason === "locked" ? 429 : reason === "scope" ? 403 : 401,
      body: { error: reason, message: data.message ?? "PIN not accepted. Check your PIN or ask your supervisor." },
    };
  }

  const branchId = data.branch_id ?? "";
  if (!UUID.test(branchId)) return { status: 502, body: unavailable };
  if (data.kind === "display") {
    if (!/^[a-f0-9]{64}$/.test(data.display_token ?? "") || !(Date.parse(data.expires_at ?? "") > Date.now())) {
      return { status: 502, body: unavailable };
    }
    return { status: 200, body: {
      kind: "display", branch_id: branchId, display_token: data.display_token, expires_at: data.expires_at,
    } };
  }

  const userId = data.user_id ?? "";
  if (!UUID.test(userId)) return { status: 502, body: unavailable };
  const { data: identity, error: identityError } = await admin.auth.admin.getUserById(userId);
  const email = identity?.user?.email;
  if (identityError || !email) {
    return { status: 403, body: { error: "account", message: "Your staff sign-in account is unavailable. Ask your supervisor for help." } };
  }
  const { data: proof, error: proofError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const loginToken = proof?.properties?.hashed_token;
  if (proofError || !loginToken) return { status: 502, body: unavailable };
  return { status: 200, body: { token_hash: loginToken, branch_id: branchId } };
}

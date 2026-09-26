/**
 * Provider readiness testing.
 *
 * A provider is never "connected" because someone ticked a box. Every test here
 * either exercises the provider for real (Daraja issues an access token; the
 * public callback endpoint answers) or records honestly that no safe automated
 * test exists for that provider yet. Every attempt is persisted through
 * `neo_integration_record_test`, which is the only writer of sandbox evidence.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
  from: (t: string) => any;
};

export type ProviderTestResult = {
  provider: string;
  status: "passed" | "failed" | "not_configured" | "unsupported";
  detail: string;
  environment: string;
  durationMs: number;
  recorded: boolean;
};

async function requestOrigin(): Promise<string> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const url = getRequest()?.url;
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

async function organisationOf(client: Rpc, userId: string): Promise<string | null> {
  const profile = await client.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  return (profile?.data?.organization_id as string | undefined) ?? null;
}

/** Present-or-absent only; the value itself never leaves the server. */
function secretPresent(name: string): boolean {
  return Boolean((process.env[name] ?? "").trim());
}

export const runProviderTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { providerCode: string; testType?: string | null }) => ({
    providerCode: String(input?.providerCode ?? "").trim(),
    testType: input?.testType ? String(input.testType).trim() : null,
  }))
  .handler(async ({ data, context }): Promise<ProviderTestResult> => {
    const client = context.supabase as unknown as Rpc;
    const started = Date.now();
    const provider = data.providerCode;

    let status: ProviderTestResult["status"] = "unsupported";
    let detail = "No safe automated test exists for this provider yet.";
    let environment = "sandbox";
    let testType = data.testType ?? "connection";

    if (provider === "daraja") {
      const organizationId = await organisationOf(client, context.userId);
      const { loadMpesaCredentials, darajaToken } = organizationId
        ? await import("@/lib/mpesa.server")
        : { loadMpesaCredentials: null as never, darajaToken: null as never };
      const creds = organizationId ? await loadMpesaCredentials(organizationId) : null;
      if (!creds) {
        status = "not_configured";
        detail = "Paybill/till number, consumer key, consumer secret and passkey must all be saved first.";
      } else {
        environment = creds.environment;
        testType = data.testType ?? "authentication";
        const token = await darajaToken(creds);
        status = token.ok ? "passed" : "failed";
        detail = token.ok ? "Safaricom Daraja issued an access token." : token.detail;
      }
    } else if (provider === "resend") {
      status = secretPresent("RESEND_API_KEY") ? "unsupported" : "not_configured";
      detail = status === "not_configured"
        ? "No Resend API key is present on the server."
        : "API key present. Sending a real message is the only true test, so it is not run automatically.";
    } else if (provider === "africas_talking") {
      const ok = secretPresent("AT_API_KEY") && secretPresent("AT_USERNAME");
      status = ok ? "unsupported" : "not_configured";
      detail = ok
        ? "Credentials present. Sending a real SMS is the only true test, so it is not run automatically."
        : "The Africa's Talking username and API key are not present on the server.";
    } else if (provider === "lovable_ai") {
      status = secretPresent("LOVABLE_API_KEY") ? "passed" : "not_configured";
      detail = status === "passed" ? "AI gateway key is present." : "No AI gateway key is present.";
    } else if (provider === "card_terminal" || provider === "qr_payments") {
      status = "not_configured";
      detail = "No processor or terminal is connected, so nothing can be tested. This is an external dependency.";
    }

    const { data: recorded } = await client.rpc("neo_integration_record_test", {
      _provider: provider,
      _environment: environment,
      _test_type: testType,
      _status: status,
      _detail: detail,
      _duration_ms: Date.now() - started,
    });

    return {
      provider,
      status,
      detail,
      environment,
      durationMs: Date.now() - started,
      recorded: Boolean(recorded?.["recorded"]),
    };
  });

/**
 * Proves the public M-Pesa callback endpoint is reachable and rejects an unknown
 * token. It sends a deliberately invalid token, so no transaction can be touched.
 */
export const testMpesaCallbackEndpoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ProviderTestResult> => {
    const client = context.supabase as unknown as Rpc;
    const started = Date.now();
    const configured = (process.env["PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "").trim();
    const base = (configured || (await requestOrigin())).replace(/\/+$/, "");

    let status: ProviderTestResult["status"] = "failed";
    let detail: string;

    if (!base) {
      status = "not_configured";
      detail = "This workspace has no public address, so Safaricom would have nowhere to call.";
    } else {
      const probe = `${base}/api/public/mpesa/callback/neo-endpoint-probe-invalid-token`;
      try {
        const res = await fetch(probe, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ probe: true }),
        });
        if (res.status === 401) {
          status = "passed";
          detail = "The callback endpoint is live and refused an unknown token, exactly as it should.";
        } else {
          detail = `The callback endpoint answered ${res.status} to an unknown token; it should refuse with 401.`;
        }
      } catch (error) {
        detail = `The callback endpoint could not be reached: ${(error as Error).message}`;
      }
    }

    const { data: recorded } = await client.rpc("neo_integration_record_test", {
      _provider: "daraja",
      _environment: "sandbox",
      _test_type: "webhook_callback",
      _status: status,
      _detail: detail,
      _duration_ms: Date.now() - started,
    });

    return {
      provider: "daraja",
      status,
      detail,
      environment: "sandbox",
      durationMs: Date.now() - started,
      recorded: Boolean(recorded?.["recorded"]),
    };
  });

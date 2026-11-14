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

import type { ProviderTestResult } from "@/lib/integration-test-evidence";
export type { ProviderTestResult } from "@/lib/integration-test-evidence";

async function requestOrigin(): Promise<string> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const url = getRequest()?.url;
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

/** Match the installed test-recording authority before loading credentials or probing. */
async function assertIntegrationTestAuthority(client: Rpc): Promise<string> {
  const org = await client.rpc("current_org_id");
  if (org.error || typeof org.data !== "string" || !org.data.trim()) throw new Error("No active organisation is available for this integration test.");
  const admin = await client.rpc("is_org_admin");
  if (!admin.error && admin.data === true) return org.data;
  const permissions = await Promise.all([
    client.rpc("has_permission", { _module: "integrations", _feature: "providers", _action: "edit" }),
    client.rpc("has_permission", { _module: "administration", _feature: "workspace", _action: "edit" }),
  ]);
  if (!permissions.some((r) => !r.error && r.data === true)) throw new Error("You do not have permission to test integrations.");
  return org.data;
}

async function recordTest(client: Rpc, args: Record<string, unknown>) {
  const { data, error } = await client.rpc("neo_integration_record_test", args);
  if (error) throw new Error("The integration test ran, but its evidence could not be saved. " + error.message);
  if (data?.["recorded"] !== true || data?.["status"] !== args["_status"]) throw new Error("The integration test evidence was not confirmed by the database. Refresh before trying again.");
}

/** Present-or-absent only; the value itself never leaves the server. */
function secretPresent(name: string): boolean {
  return Boolean((process.env[name] ?? "").trim());
}

export const runProviderTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { providerCode: string; testType?: string | null }) => {
    const providerCode = String(input?.providerCode ?? "").trim();
    if (!["daraja", "resend", "africas_talking", "lovable_ai", "card_terminal", "qr_payments"].includes(providerCode)) throw new Error("Choose a supported integration provider.");
    const testType = input?.testType ? String(input.testType).trim() : null;
    if (testType && !["connection", "authentication"].includes(testType)) throw new Error("This provider check cannot certify the requested test type.");
    return { providerCode, testType };
  })
  .handler(async ({ data, context }): Promise<ProviderTestResult> => {
    const client = context.supabase as unknown as Rpc;
    const started = Date.now();
    const organizationId = await assertIntegrationTestAuthority(client);
    const provider = data.providerCode;

    let status: ProviderTestResult["status"] = "unsupported";
    let detail = "No safe automated test exists for this provider yet.";
    let environment = "sandbox";
    let testType = "configuration";

    try {
    if (provider === "daraja" && process.env["NEO_LOVABLE_BRIDGE_ENABLED"] === "true") {
      // Keep this handler's stronger local authority/evidence checks. Only the
      // credential-bearing OAuth probe uses the existing managed command.
      const { testManagedSavedMpesaConnection } = await import("@/lib/managed-mpesa-connection-test.server");
      const { getRequest } = await import("@tanstack/react-start/server");
      const result = await testManagedSavedMpesaConnection(getRequest());
      environment = result.environment ?? "unknown";
      testType = "authentication";
      status = result.ok === true && result.status === "ok" ? "passed" : "failed";
      detail = result.detail ?? "The managed backend did not confirm Daraja authentication.";
    } else if (provider === "daraja") {
      const { loadMpesaCredentials, darajaToken } = await import("@/lib/mpesa.server");
      const creds = await loadMpesaCredentials(organizationId);
      if (!creds) {
        status = "not_configured";
        detail = "Paybill/till number, consumer key, consumer secret and passkey must all be saved first.";
      } else {
        environment = creds.environment;
        testType = "authentication";
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
      status = secretPresent("LOVABLE_API_KEY") ? "unsupported" : "not_configured";
      detail = status === "unsupported" ? "AI gateway key is present, but no provider response has been verified. Configuration presence is not a connection test." : "No AI gateway key is present.";
    } else if (provider === "card_terminal" || provider === "qr_payments") {
      status = "not_configured";
      detail = "No processor or terminal is connected, so nothing can be tested. This is an external dependency.";
    }

    } catch {
      status = "failed";
      detail = "Provider verification could not be completed. Check the server/provider configuration and try again.";
    }

    await recordTest(client, {
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
      recorded: true,
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
    const organizationId = await assertIntegrationTestAuthority(client);
    const configured = (process.env["PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "").trim();
    const base = (configured || (await requestOrigin())).replace(/\/+$/, "");

    let status: ProviderTestResult["status"] = "failed";
    let detail: string;

    if (!base) {
      status = "not_configured";
      detail = "This workspace has no public address, so Safaricom would have nowhere to call.";
    } else {
      const probe = `${base}/api/public/mpesa/callback/neo-endpoint-probe-${crypto.randomUUID()}`;
      try {
        const res = await fetch(probe, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ probe: true }),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        const responseBody = await res.text();
        if (res.status === 401 && responseBody.trim() === "Invalid callback token") {
          status = "passed";
          detail = "The callback endpoint is live and refused an unknown token, exactly as it should.";
        } else {
          detail = `The callback endpoint answered ${res.status}, but its expected invalid-token rejection was not verified.`;
        }
      } catch (error) {
        detail = `The callback endpoint could not be reached: ${(error as Error).message}`;
      }
    }

    await recordTest(client, {
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
      recorded: true,
    };
  });

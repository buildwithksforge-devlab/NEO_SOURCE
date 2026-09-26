import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";

/**
 * Provisioning is authenticated-only. Every call site must prove a live
 * session exists — and that the access token belongs to the user being
 * provisioned — before the privileged onboarding RPCs are reached.
 */
export type ProvisionStage =
  | "idle"
  | "creating-account"
  | "verify-email"
  | "establishing-session"
  | "creating-organization"
  | "creating-property"
  | "applying-configuration"
  | "ready";

export const STAGE_TEXT: Record<ProvisionStage, string> = {
  idle: "",
  "creating-account": "Creating account…",
  "verify-email": "Email verification required",
  "establishing-session": "Establishing secure session…",
  "creating-organization": "Creating organisation…",
  "creating-property": "Creating first property…",
  "applying-configuration": "Applying workspace configuration…",
  ready: "Workspace ready",
};

/**
 * Waits until the Supabase client has actually applied an authenticated
 * session and the server confirms the user. Returns the verified user id, or
 * null when no session is available (e.g. email confirmation is required).
 */
export async function awaitAuthenticatedUser(timeoutMs = 8000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) {
      const { data: verified, error } = await supabase.auth.getUser();
      if (!error && verified.user) return verified.user.id;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export type ProvisionResult = {
  status: "created" | "recovered";
  organizationId?: string | null;
};

type WorkspaceFinalization = {
  status?: string;
  reason?: string;
  organization_id?: string;
  access?: { state?: string; is_org_admin?: boolean };
};

function readFinalization(data: unknown): ProvisionResult {
  const result = (data ?? null) as WorkspaceFinalization | null;
  if (
    !result ||
    (result.status !== "created" && result.status !== "recovered") ||
    result.access?.state !== "ready" ||
    result.access?.is_org_admin !== true
  ) {
    throw new Error(result?.reason ?? "Your workspace could not be completed securely.");
  }
  return { status: result.status, organizationId: result.organization_id ?? null };
}

/**
 * Registers the onboarding attempt (idempotent) and provisions the workspace.
 * Must only be called once `awaitAuthenticatedUser()` has resolved a user id.
 */
export async function provisionWorkspace(
  payload: Record<string, unknown>,
  idempotencyKey: string,
  onStage?: (stage: ProvisionStage) => void,
): Promise<ProvisionResult> {
  onStage?.("creating-organization");
  const { error: attemptError } = await guardedRpc(supabase, "neo_register_workspace_attempt", {
    _email: String(payload["business_email"] ?? ""),
    _payload: payload as never,
    _idempotency_key: idempotencyKey,
  });
  if (attemptError) throw new Error(attemptError.message);

  onStage?.("creating-property");
  const { data, error } = await guardedRpc(supabase, "neo_reconcile_workspace");
  if (error) throw new Error(error.message);

  onStage?.("applying-configuration");
  return readFinalization(data);
}

/** Explicitly resumes only the signed-in creator's own recorded workspace. */
export async function recoverMyWorkspace(): Promise<ProvisionResult> {
  const { data, error } = await guardedRpc(supabase, "neo_recover_my_workspace");
  if (error) throw new Error(error.message);
  return readFinalization(data);
}

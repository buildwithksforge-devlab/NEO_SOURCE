import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { buildStaffInviteMetadata } from "@/lib/auth-email-metadata";
import {
  normaliseStaffAccountInput,
  validateStaffAccountInput,
} from "@/lib/staff-account-input";

type CapabilityClient = Pick<SupabaseClient<Database>, "rpc">;

/**
 * Authority for staff administration comes from effective capabilities, never
 * from a role name or the organisation-admin flag. `is_org_admin` remains a
 * fallback so an Owner is never locked out of their own workspace.
 */
async function requireCapability(
  supabase: CapabilityClient,
  feature: string,
  action: string,
) {
  const { data: allowed } = await supabase.rpc("has_permission", {
    _module: "administration",
    _feature: feature,
    _action: action,
  });
  if (allowed === true) return;
  const { data: isAdmin } = await supabase.rpc("is_org_admin");
  if (isAdmin !== true) throw new Error("Forbidden");
}

/**
 * Canonical role â†” department â†” property check. The interface filters the
 * dropdowns, but a typed request must never seat a role in a department it does
 * not belong to, so the same catalogue relationships are re-evaluated in the
 * database by `neo_validate_role_assignment` before anything is written.
 */
async function requireValidAssignment(
  supabase: CapabilityClient,
  branchId: string | null,
  departmentId: string | null,
  roleIds: string[],
) {
  const { error } = await supabase.rpc("neo_validate_role_assignment" as never, {
    _branch: branchId,
    _department: departmentId,
    _role_ids: roleIds ?? [],
  } as never);
  if (error) throw new Error(error.message);
}


type CreateInput = {
  email: string;
  password: string;
  full_name: string;
  staff_id: string;
  phone: string;
  job_title: string;
  branch_id: string | null;
  department_id: string | null;
  station_id?: string | null;
  employment_status: string;
  role_ids: string[];
  primary_role_id?: string | null;
  /** Organisational reporting line, chosen from the canonical candidates. */
  reporting_manager_profile_id?: string | null;
};


/**
 * Universal worker provisioning.
 *
 * The authentication account is the only thing created here; everything that
 * makes a worker functional â€” profile, property, department, work area, roles,
 * primary role, notification preferences and the audit record â€” is written by
 * the single backend routine `neo_provision_worker`, which validates scope,
 * refuses to grant restricted authority incidentally and records a resumable
 * provisioning run. Retrying with the same account produces no duplicates.
 */

export const createStaffUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CreateInput) => {
    const normalised = normaliseStaffAccountInput(input);
    const problem = validateStaffAccountInput(normalised);
    if (problem) throw new Error(problem);
    return normalised;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    await requireCapability(supabase, "users", "create");
    await requireValidAssignment(
      supabase,
      data.branch_id,
      data.department_id,
      data.role_ids,
    );

    const { data: me } = await supabase
      .from("profiles")
      .select("organization_id, full_name")
      .eq("id", userId)
      .maybeSingle();

    if (!me?.organization_id) {
      throw new Error("No organization");
    }

    const [{ data: org }, { data: property }, { data: role }] =
      await Promise.all([
        supabase
          .from("organizations")
          .select("name")
          .eq("id", me.organization_id)
          .maybeSingle(),

        data.branch_id
          ? supabase
              .from("branches")
              .select("name")
              .eq("id", data.branch_id)
              .maybeSingle()
          : Promise.resolve({
              data: null as { name: string } | null,
            }),

        data.primary_role_id ?? data.role_ids[0]
          ? supabase
              .from("roles")
              .select("name")
              .eq(
                "id",
                (data.primary_role_id ?? data.role_ids[0]) as string,
              )
              .maybeSingle()
          : Promise.resolve({
              data: null as { name: string } | null,
            }),
      ]);

    const inviteMetadata = buildStaffInviteMetadata({
      full_name: data.full_name,
      organisation_name: org?.name ?? null,
      property_name: property?.name ?? null,
      role_title: role?.name ?? null,
      job_title: data.job_title,
      invited_by_name: me.full_name ?? null,
    });

    /*
     * Worker creation uses an isolated public Auth client.
     *
     * Never use the administrator's authenticated Supabase client for signUp:
     * a successful signup must not replace the administrator's session.
     *
     * Ordinary staff creation also does not require auth.admin or a
     * SUPABASE_SERVICE_ROLE_KEY.
     */
    const supabaseUrl = process.env["SUPABASE_URL"];
    const publishableKey = process.env["SUPABASE_PUBLISHABLE_KEY"];

    if (!supabaseUrl || !publishableKey) {
      throw new Error(
        "Supabase public authentication is not configured on this server",
      );
    }

    const signupClient = createClient<Database>(
      supabaseUrl,
      publishableKey,
      {
        auth: {
          storage: undefined,
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );

    const created = await signupClient.auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        data: inviteMetadata,
      },
    });

    if (created.error) {
      throw new Error(created.error.message);
    }

    const newUser = created.data.user;

    /*
     * Supabase can deliberately obscure duplicate e-mail registrations.
     * An empty identities collection is therefore not accepted as evidence
     * that a new worker account was created.
     */
    if (
      !newUser?.id ||
      (Array.isArray(newUser.identities) &&
        newUser.identities.length === 0)
    ) {
      throw new Error(
        "That email address already belongs to an account.",
      );
    }

    const newUserId = newUser.id;

    const { data: result, error } = await supabase.rpc(
      "neo_provision_worker",
      {
        _payload: {
          user_id: newUserId,
          email: data.email,
          full_name: data.full_name,
          staff_id: data.staff_id,
          phone: data.phone,
          job_title: data.job_title,
          branch_id: data.branch_id,
          department_id: data.department_id,
          station_id: data.station_id ?? null,
          role_ids: data.role_ids,
          primary_role_id:
            data.primary_role_id ??
            data.role_ids[0] ??
            null,
          reporting_manager_profile_id:
            data.reporting_manager_profile_id ?? null,
          employment_status: data.employment_status,
          idempotency_key: `worker:${data.email.toLowerCase()}`,
        } as never,
      },
    );

    if (error) {
      throw new Error(error.message);
    }

    return {
      id: newUserId,
      provisioning:
        (result ?? null) as Record<string, string> | null,
      emailConfirmationRequired: !created.data.session,
    };
  });

type AssignmentInput = {
  user_id: string;
  job_title: string;
  employment_status: string;
  branch_id: string | null;
  department_id: string | null;
  station_id: string | null;
  role_ids: string[];
  reporting_manager_profile_id?: string | null;
};


/**
 * Single authoritative write path for an employee's assignment.
 *
 * User Management previously edited nothing but the account status, so a role,
 * property, department or station change made in the interface never reached
 * `user_roles`, `user_branches`, `user_departments` or `user_stations` â€” which
 * is exactly why Role Testing and an actual login disagreed with the directory.
 * Everything is written together here, always org-scoped and audited.
 */
export const updateStaffAssignment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: AssignmentInput) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    await requireCapability(supabase, "users", "edit");
    await requireValidAssignment(supabase, data.branch_id, data.department_id, data.role_ids);


    const { data: me } = await supabase
      .from("profiles")
      .select("organization_id, full_name")
      .eq("id", userId)
      .maybeSingle();
    const organizationId = me?.organization_id;
    if (!organizationId) throw new Error("No organization");

    // Target must live in the caller's organisation â€” never cross-tenant.
    const { data: target } = await supabase
      .from("profiles")
      .select("id, organization_id, branch_id, department_id, job_title, employment_status")
      .eq("id", data.user_id)
      .maybeSingle();
    if (!target || target.organization_id !== organizationId) {
      throw new Error("User not found in your organization");
    }

    /**
     * Everything below is validated *before* anything is written, and the
     * write itself happens inside one database routine. A station change can
     * therefore never leave the account with its role deleted because a later
     * step failed â€” either the whole assignment lands or none of it does.
     */
    let previousManagerId: string | null = null;
    let newManagerId: string | null = null;
    let reviewRequired = false;
    let reviewReason = "";
    const setManager = data.reporting_manager_profile_id !== undefined;

    if (setManager) {
      const { data: currentLine } = await supabase
        .from("profiles")
        .select("reporting_manager_id")
        .eq("id", data.user_id)
        .maybeSingle();
      previousManagerId =
        (currentLine as { reporting_manager_id: string | null } | null)?.reporting_manager_id ??
        null;
      newManagerId = data.reporting_manager_profile_id || null;

      if (newManagerId) {
        if (newManagerId === data.user_id) {
          throw new Error("An employee cannot report to themselves");
        }
        const { data: candidates, error: candidateError } = await supabase.rpc(
          "neo_reporting_candidates" as never,
          {
            _user: data.user_id,
            _branch: data.branch_id,
            _department: data.department_id,
            _station: data.station_id,
            _role_ids: data.role_ids,
          } as never,
        );
        if (candidateError) throw new Error(candidateError.message);
        const eligible = ((candidates ?? []) as { profile_id: string }[]).some(
          (c) => c.profile_id === newManagerId,
        );
        if (!eligible) {
          throw new Error(
            "That manager is not eligible for this employee's roles, department or property",
          );
        }
      } else {
        const { data: meta } = await supabase.rpc("neo_role_reporting_meta" as never, {
          _role_ids: data.role_ids,
        } as never);
        const required = ((meta ?? []) as { manager_required: boolean }[])[0]?.manager_required;
        if (required) {
          reviewRequired = true;
          reviewReason = "No reporting manager recorded â€” confirm the reporting line.";
        }
      }
    }

    const { data: saved, error: saveError } = await supabase.rpc(
      "neo_staff_assignment_save" as never,
      {
        _user: data.user_id,
        _job_title: data.job_title,
        _employment_status: data.employment_status,
        _branch: data.branch_id || null,
        _department: data.department_id || null,
        _role_ids: data.role_ids,
        _station: data.station_id || null,
        _reporting_manager: newManagerId,
        _set_reporting_manager: setManager,
      } as never,
    );
    if (saveError) throw new Error(saveError.message);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (setManager) {
      await supabaseAdmin
        .from("profiles")
        .update({
          reporting_effective_from: newManagerId ? new Date().toISOString().slice(0, 10) : null,
          assignment_review_required: reviewRequired,
          assignment_review_reason: reviewReason,
        })
        .eq("id", data.user_id)
        .eq("organization_id", organizationId);
    }

    const snapshot = (saved ?? {}) as { before?: unknown; after?: unknown };

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: organizationId,
      user_id: userId,
      user_name: me?.full_name ?? "",
      action: "user.assignment_updated",
      module: "administration",
      record_id: data.user_id,
      previous_value: (snapshot.before ?? {
        branch_id: target.branch_id,
        department_id: target.department_id,
        job_title: target.job_title,
        employment_status: target.employment_status,
        reporting_manager_id: previousManagerId,
      }) as never,
      new_value: (snapshot.after ?? {
        branch_id: data.branch_id,
        department_id: data.department_id,
        station_id: data.station_id,
        job_title: data.job_title,
        employment_status: data.employment_status,
        role_ids: data.role_ids,
        reporting_manager_id: newManagerId,
      }) as never,
    });

    return { ok: true, assignment: snapshot.after ?? null };
  });

/** Administrator-driven password reset with a forced change on next sign-in. */
export const resetStaffPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; password: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "reset_auth");

    const { data: target } = await supabase
      .from("profiles")
      .select("organization_id")
      .eq("id", data.user_id)
      .maybeSingle();
    if (!target?.organization_id) throw new Error("User not found in your organization");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const res = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      password: data.password,
    });
    if (res.error) throw new Error(res.error.message);

    await supabaseAdmin
      .from("profiles")
      .update({ must_change_password: true })
      .eq("id", data.user_id);

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: "user.password_reset",
      module: "administration",
      record_id: data.user_id,
    });

    return { ok: true };
  });

/** Account status change (activate, deactivate, suspend, reactivate). */
export const setStaffAccountStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; status: "active" | "inactive" | "suspended" }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "manage_status");

    const { data: target } = await supabase
      .from("profiles")
      .select("organization_id, account_status")
      .eq("id", data.user_id)
      .maybeSingle();
    if (!target?.organization_id) throw new Error("User not found in your organization");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ account_status: data.status })
      .eq("id", data.user_id)
      .eq("organization_id", target.organization_id);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: `user.${data.status}`,
      module: "administration",
      record_id: data.user_id,
      previous_value: { account_status: target.account_status } as never,
      new_value: { account_status: data.status } as never,
    });
    return { ok: true };
  });

/** Force a password change at the next sign-in without changing the password. */
export const requireStaffPasswordChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "require_password_change");

    const { data: target } = await supabase
      .from("profiles")
      .select("organization_id")
      .eq("id", data.user_id)
      .maybeSingle();
    if (!target?.organization_id) throw new Error("User not found in your organization");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ must_change_password: true })
      .eq("id", data.user_id);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: "user.password_change_required",
      module: "administration",
      record_id: data.user_id,
    });
    return { ok: true };
  });

/** Re-issue the sign-in invitation for a worker who never completed setup. */
export const resendStaffInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; redirect_to?: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "resend_invitation");

    const { data: target } = await supabase
      .from("profiles")
      .select("organization_id, email")
      .eq("id", data.user_id)
      .maybeSingle();
    if (!target?.organization_id) throw new Error("User not found in your organization");
    if (!target.email) throw new Error("This account has no email address on file");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const link = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: target.email,
      options: { redirectTo: data.redirect_to ?? "" },
    });
    if (link.error) throw new Error(link.error.message);

    await supabaseAdmin
      .from("profiles")
      .update({ invitation_status: "sent", invited_at: new Date().toISOString(), invited_by: userId })
      .eq("id", data.user_id);

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: "user.invitation_resent",
      module: "administration",
      record_id: data.user_id,
    });
    return { ok: true, action_link: link.data.properties?.action_link ?? null };
  });

/**
 * Individual permission grant or denial, optionally time-limited.
 *
 * An individual grant never widens what the workspace itself allows: it can
 * only name a capability that already exists in the catalogue, and the
 * effective-access resolver still applies scope and denials afterwards.
 */
export const setUserPermissionOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      user_id: string;
      module: string;
      feature: string;
      action: string;
      effect: "grant" | "deny" | "clear";
      valid_until?: string | null;
      reason?: string | null;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "override_permission");

    const { data: target } = await supabase
      .from("profiles")
      .select("organization_id")
      .eq("id", data.user_id)
      .maybeSingle();
    if (!target?.organization_id) throw new Error("User not found in your organization");

    const { data: permission } = await supabase
      .from("permissions")
      .select("id")
      .eq("module", data.module)
      .eq("feature", data.feature)
      .eq("action", data.action)
      .maybeSingle();
    if (!permission?.id) throw new Error("Unknown capability");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.effect === "clear") {
      await supabaseAdmin
        .from("user_permissions")
        .delete()
        .eq("user_id", data.user_id)
        .eq("permission_id", permission.id);
    } else {
      const { error } = await supabaseAdmin.from("user_permissions").upsert(
        {
          organization_id: target.organization_id,
          user_id: data.user_id,
          permission_id: permission.id,
          effect: data.effect,
          granted_by: userId,
          valid_from: new Date().toISOString(),
          valid_until: data.valid_until ?? null,
          reason: data.reason ?? null,
        },
        { onConflict: "user_id,permission_id" },
      );
      if (error) throw new Error(error.message);
    }

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: `user.permission_${data.effect}`,
      module: "administration",
      record_id: data.user_id,
      new_value: {
        module: data.module,
        feature: data.feature,
        action: data.action,
        effect: data.effect,
        valid_until: data.valid_until ?? null,
        reason: data.reason ?? null,
      } as never,
    });
    return { ok: true };
  });

/**
 * Deliberate Owner assignment.
 *
 * Authority is one canonical capability â€” `administration.users.assign_owner` â€”
 * never a role name, job title or email. The database routine re-checks that
 * capability, refuses another organisation, refuses a platform administrator,
 * allocates a missing staff identifier from the organisation-scoped allocator
 * and records complete before/after audit evidence. Repeating the call is a
 * no-op, so a confirmed assignment can never duplicate the Owner role.
 */
export const assignOwnerRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; reason: string; idempotency_key?: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requireCapability(supabase, "users", "assign_owner");
    const { data: result, error } = await supabase.rpc("neo_assign_owner_role", {
      _target: data.user_id,
      _reason: data.reason,
      _idempotency_key: data.idempotency_key ?? null,
    } as never);
    if (error) throw new Error(error.message);
    return result as { ok: boolean; changed: boolean; staff_id: string | null };
  });

/** Owner removal, refused while the target is the last active Owner. */
export const removeOwnerRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; reason: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requireCapability(supabase, "users", "assign_owner");
    const { data: result, error } = await supabase.rpc("neo_remove_owner_role", {
      _target: data.user_id,
      _reason: data.reason,
    } as never);
    if (error) throw new Error(error.message);
    return result as { ok: boolean; changed: boolean };
  });

/* ---------------------- restored account administration ---------------------- */

/**
 * Every mutation below is server-authorised through the same capability gate and
 * writes an audit record with actor, target, previous/new state and, where the
 * action carries consequence, the reason given by the administrator. No handler
 * ever reads or returns an existing password, hash or token â€” a password can
 * only be replaced, never revealed.
 */
async function loadTarget(
  supabase: CapabilityClient & { from: SupabaseClient<Database>["from"] },
  userId: string,
) {
  const { data: target } = await supabase
    .from("profiles")
    .select("organization_id, account_status, must_change_password, email, full_name")
    .eq("id", userId)
    .maybeSingle();
  if (!target?.organization_id) throw new Error("User not found in your organization");
  return { ...target, organization_id: target.organization_id as string };
}

/** Clears an outstanding "must change password" requirement. */
export const clearStaffPasswordRequirement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; reason?: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "require_password_change");
    const target = await loadTarget(supabase as never, data.user_id);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ must_change_password: false })
      .eq("id", data.user_id);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: "user.password_change_requirement_cleared",
      module: "administration",
      record_id: data.user_id,
      previous_value: { must_change_password: true } as never,
      new_value: { must_change_password: false } as never,
      reason: data.reason ?? null,
    });
    return { ok: true };
  });

/**
 * Force sign-out. All refresh tokens for the account are revoked through the
 * Auth admin logout endpoint, so open sessions cannot be resumed.
 */
export const revokeStaffSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; reason?: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "reset_auth");
    const target = await loadTarget(supabase as never, data.user_id);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const url = process.env["SUPABASE_URL"]!;
    const key = process.env["SUPABASE_SERVICE_ROLE_KEY"]!;
    const res = await fetch(`${url}/auth/v1/admin/users/${data.user_id}/logout`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error("Sessions could not be revoked. Please try again.");
    }

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: "user.sessions_revoked",
      module: "administration",
      record_id: data.user_id,
      reason: data.reason ?? null,
    });
    return { ok: true };
  });

/** Clears two-factor enrolment so the person can enrol a new device. */
export const resetStaffMfa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; reason?: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "reset_auth");
    const target = await loadTarget(supabase as never, data.user_id);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const account = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    if (account.error) throw new Error(account.error.message);
    const factors = account.data.user?.factors ?? [];
    for (const factor of factors) {
      const removed = await supabaseAdmin.auth.admin.mfa.deleteFactor({
        id: factor.id,
        userId: data.user_id,
      });
      if (removed.error) throw new Error(removed.error.message);
    }

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: "user.mfa_reset",
      module: "administration",
      record_id: data.user_id,
      previous_value: { factors: factors.length } as never,
      new_value: { factors: 0 } as never,
      reason: data.reason ?? null,
    });
    return { ok: true, removed: factors.length };
  });

/**
 * Sign-in and security metadata for the account panel. Only non-secret
 * attributes are returned â€” never a password hash, recovery code or token.
 */
export const getStaffSecurityMetadata = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requireCapability(supabase, "users", "view_access");
    const target = await loadTarget(supabase as never, data.user_id);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const account = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    if (account.error) throw new Error(account.error.message);
    const u = account.data.user;
    const factors = u?.factors ?? [];
    // Only non-secret enrolment attributes: a factor's identifier, shared secret
    // or recovery codes are never read here and never leave the server.
    const verified = factors.filter((f) => (f as { status?: string }).status === "verified");
    return {
      email: target.email,
      account_status: target.account_status,
      must_change_password: target.must_change_password === true,
      last_sign_in_at: u?.last_sign_in_at ?? null,
      email_confirmed_at: u?.email_confirmed_at ?? null,
      created_at: u?.created_at ?? null,
      updated_at: u?.updated_at ?? null,
      mfa_factors: factors.length,
      mfa_verified_factors: verified.length,
      mfa_state: (factors.length > 0 ? "enrolled" : "not_enrolled") as
        | "enrolled"
        | "not_enrolled",
      mfa_factor_types: [
        ...new Set(factors.map((f) => (f as { factor_type?: string }).factor_type ?? "unknown")),
      ],
      providers: (u?.identities ?? []).map((i) => i.provider),
    };
  });

/**
 * Ends employment through the canonical HR workflow. The HR record, employment
 * history and exit clearance are preserved; role assignments and sign-in rights
 * are closed in the same transaction when access revocation is requested.
 */
export const offboardStaffAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      user_id: string;
      last_working_day?: string | null;
      separation_type: string;
      reason?: string | null;
      revoke_access: boolean;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "manage_status");
    const target = await loadTarget(supabase as never, data.user_id);

    const { data: employee } = await supabase
      .from("employees")
      .select("id")
      .eq("profile_id", data.user_id)
      .maybeSingle();
    if (!employee?.id) {
      throw new Error("This account has no HR employee record to offboard.");
    }

    const { data: result, error } = await supabase.rpc("neo_hr_offboard_employee", {
      _employee: employee.id,
      _last_working_day: data.last_working_day || null,
      _separation_type: data.separation_type,
      _reason: data.reason || null,
      _revoke_access: data.revoke_access,
    } as never);
    if (error) throw new Error(error.message);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: "user.offboarded",
      module: "administration",
      record_id: data.user_id,
      previous_value: { account_status: target.account_status } as never,
      new_value: {
        separation_type: data.separation_type,
        access_revoked: data.revoke_access,
      } as never,
      reason: data.reason ?? null,
    });
    return result as { employee_id: string; already_exited: boolean; account_closed: boolean };
  });

/**
 * Removes the login account itself. The HR record and audit history remain, so
 * the trail survives the deletion; the action is refused for the signed-in
 * administrator's own account and demands a reason.
 */
export const deleteStaffAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; reason: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireCapability(supabase, "users", "delete");
    if (data.user_id === userId) throw new Error("You cannot delete your own account.");
    if (!data.reason?.trim()) throw new Error("A reason is required.");
    const target = await loadTarget(supabase as never, data.user_id);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("audit_logs").insert({
      organization_id: target.organization_id,
      user_id: userId,
      action: "user.account_deleted",
      module: "administration",
      record_id: data.user_id,
      previous_value: {
        account_status: target.account_status,
        email: target.email,
        full_name: target.full_name,
      } as never,
      reason: data.reason.trim(),
    });

    await supabaseAdmin
      .from("profiles")
      .update({ account_status: "inactive" })
      .eq("id", data.user_id);
    const removed = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (removed.error) throw new Error(removed.error.message);
    return { ok: true };
  });


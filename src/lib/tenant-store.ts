/**
 * Database-backed tenant workspace store.
 *
 * The organization identity lives in `public.organizations`, the properties in
 * `public.branches`, and every workspace configuration section (contact,
 * branding, regional, dashboard, templates) in `public.organization_settings`.
 *
 * Nothing here seeds or invents a tenant: when the signed-in user has no
 * organization we simply report `null` and the UI shows "Not configured".
 */
import { supabase } from "@/integrations/supabase/client";
import { recallOrganizationId, rememberOrganizationId } from "./access-cache";

import { defaultTenantState, nowIso } from "./tenant-defaults";
import type { Branch, BusinessType, TenantState } from "./tenant-types";

export type TenantLoad = {
  organizationId: string;
  state: TenantState;
};

/**
 * Resolve the organization of the signed-in staff user, if any.
 *
 * The signed-in user's organisation is already resolved once during sign-in, so
 * it is recalled from the session cache instead of repeating the `profiles`
 * read on every workspace hydration.
 */
export async function resolveOrganizationId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return null;
  const cached = recallOrganizationId(user.id);
  if (cached !== undefined) return cached;
  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  const orgId = (profile as { organization_id?: string } | null)?.organization_id ?? null;
  rememberOrganizationId(user.id, orgId);
  return orgId;
}


function mapBranch(row: Record<string, unknown>): Branch {
  return {
    id: String(row["id"]),
    organizationId: String(row["organization_id"] ?? ""),
    name: String(row["name"] ?? ""),
    code: String(row["code"] ?? ""),
    address: String(row["address"] ?? ""),
    phone: String(row["phone"] ?? ""),
    email: String(row["email"] ?? ""),
    isMain: Boolean(row["is_main"]),
    active: row["active"] !== false,
    logo: (row["logo_url"] as string | null) ?? null,
    createdAt: String(row["created_at"] ?? nowIso()),
    updatedAt: String(row["updated_at"] ?? nowIso()),
  };
}

/**
 * Load the full tenant workspace for an organization from the database.
 *
 * Properties are read through `fetchBranches` when supplied, so the workspace
 * and the property selector share one cached result instead of each issuing
 * its own identical query on every sign-in.
 */
export async function loadTenant(
  organizationId: string,
  fetchBranches?: () => Promise<Record<string, unknown>[]>,
): Promise<TenantState> {
  const base = defaultTenantState();

  const [orgRes, settingsRes, branchRes] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, legal_name, business_type, description, created_at, updated_at")
      .eq("id", organizationId)
      .maybeSingle(),
    supabase
      .from("organization_settings")
      .select("*")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    fetchBranches
      ? fetchBranches().then((data) => ({ data }))
      : supabase
          .from("branches")
          .select("*")
          .eq("organization_id", organizationId)
          .order("is_main", { ascending: false })
          .order("name", { ascending: true }),
  ]);


  const org = orgRes.data as Record<string, unknown> | null;
  const settings = settingsRes.data as Record<string, unknown> | null;
  const branchRows = (branchRes.data ?? []) as Record<string, unknown>[];

  const section = <T,>(key: string, fallback: T): T => {
    const value = settings?.[key];
    if (!value) return fallback;
    if (Array.isArray(value)) return (value.length ? value : fallback) as T;
    if (typeof value === "object" && Object.keys(value as object).length === 0) return fallback;
    return { ...(fallback as object), ...(value as object) } as T;
  };

  return {
    ...base,
    organization: {
      ...base.organization,
      id: organizationId,
      name: String(org?.["name"] ?? ""),
      legalName: String(org?.["legal_name"] ?? ""),
      businessType: (org?.["business_type"] as BusinessType) || base.organization.businessType,
      description: String(org?.["description"] ?? ""),
      onboardingCompleted: Boolean(settings?.["onboarding_completed"]),
      createdAt: String(org?.["created_at"] ?? base.organization.createdAt),
      updatedAt: String(org?.["updated_at"] ?? base.organization.updatedAt),
    },
    contact: section("contact", base.contact),
    brand: section("brand", base.brand),
    regional: section("regional", base.regional),
    dashboard: section("dashboard", base.dashboard),
    appBranding: section("app_branding", base.appBranding),
    communicationTemplates: section("communication_templates", base.communicationTemplates),
    documentTemplates: section("document_templates", base.documentTemplates),
    branches: branchRows.map(mapBranch),
  };
}

/**
 * Persist the configuration sections. Identity fields go to `organizations`,
 * everything else to `organization_settings`. Properties are never written
 * here — Branch Management owns `public.branches`.
 */
export async function saveTenant(organizationId: string, state: TenantState): Promise<void> {
  const identity = {
    name: state.organization.name,
    legal_name: state.organization.legalName,
    business_type: state.organization.businessType,
    description: state.organization.description,
    updated_at: nowIso(),
  };

  const settings = {
    organization_id: organizationId,
    contact: state.contact,
    brand: state.brand,
    regional: state.regional,
    dashboard: state.dashboard,
    app_branding: state.appBranding,
    communication_templates: state.communicationTemplates,
    document_templates: state.documentTemplates,
    onboarding_completed: state.organization.onboardingCompleted,
  };

  const [orgResult, settingsResult] = await Promise.all([
    supabase.from("organizations").update(identity as never).eq("id", organizationId),
    supabase.from("organization_settings").upsert(settings as never, {
      onConflict: "organization_id",
    }),
  ]);

  const error = orgResult.error ?? settingsResult.error;
  if (error) throw error;
}

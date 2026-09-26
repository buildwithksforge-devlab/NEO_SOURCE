import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Configuration status derivation.
 *
 * Every badge the Configuration Centre shows is derived from saved state in the
 * database — never a hard-coded or decorative label. A surface we cannot
 * observe returns `unknown` and renders no badge at all, which is honest: an
 * absent badge means "not measured", never "configured".
 */

export type SettingsStatus =
  | "configured"
  | "needs-setup"
  | "attention"
  | "unknown";

export const STATUS_LABEL: Record<Exclude<SettingsStatus, "unknown">, string> = {
  configured: "Configured",
  "needs-setup": "Needs setup",
  attention: "Attention required",
};

/** Tables that answer "has this surface been configured at all?" by row count. */
const COUNT_PROBES: { key: string; table: string }[] = [
  { key: "/admin/branches", table: "branches" },
  { key: "/departments", table: "departments" },
  { key: "/roles", table: "roles" },
  { key: "/users", table: "profiles" },
  { key: "/rooms", table: "rooms" },
  { key: "/rates", table: "rate_plans" },
  { key: "/pos/menu", table: "menu_items" },
  { key: "/pos/settings", table: "pos_settings" },
  { key: "/kitchen/settings", table: "kitchen_settings" },
  { key: "/marketing/settings", table: "marketing_settings" },
  { key: "/events/venues", table: "event_venues" },
  { key: "/events/packages", table: "event_packages" },
  { key: "/admin/meal-plans", table: "meal_plans" },
  { key: "/admin/suppliers", table: "suppliers" },
  { key: "/admin/delivery-zones", table: "delivery_zones" },
  { key: "/admin/delivery-settings", table: "delivery_settings" },
  { key: "/admin/asset-categories", table: "asset_categories" },
  { key: "/admin/maintenance-categories", table: "maintenance_categories" },
  { key: "/admin/grounds-areas", table: "grounds_areas" },
  { key: "/admin/housekeeping-standards", table: "housekeeping_checklist_templates" },
  { key: "/admin/linen-catalogue", table: "linen_items" },
  { key: "/admin/stock-policy", table: "inventory_policies" },
];

async function countOf(table: string): Promise<number | null> {
  const { count, error } = await supabase
    // The probe list is a fixed literal above, never user input.
    .from(table as never)
    .select("*", { count: "exact", head: true });
  if (error) return null;
  return count ?? 0;
}

export type SettingsStatusMap = Record<string, SettingsStatus>;

export async function loadSettingsStatuses(): Promise<SettingsStatusMap> {
  const out: SettingsStatusMap = {};

  const counts = await Promise.all(
    COUNT_PROBES.map(async (probe) => [probe.key, await countOf(probe.table)] as const),
  );
  for (const [key, count] of counts) {
    out[key] = count === null ? "unknown" : count > 0 ? "configured" : "needs-setup";
  }

  // Payment, tax and AI provider settings hold provider credentials, so the app
  // role cannot read those tables at all. A guarded check returns presence only.
  const { data: presence } = await (
    supabase as unknown as {
      rpc: (fn: string) => Promise<{ data: { mpesa: boolean; etims: boolean; ai_provider: boolean }[] | null }>;
    }
  ).rpc("neo_settings_presence");
  const flags = presence?.[0];
  if (flags) {
    const mark = (key: string, ready: boolean) => {
      out[key] = ready ? "configured" : "needs-setup";
    };
    mark("/admin/payments-mpesa", flags.mpesa);
    mark("/finance/tax", flags.etims);
    mark("/admin/tax-etims", flags.etims);
    mark("/admin/ai-provider", flags.ai_provider);
  }


  // Organisation identity, regional rules and branding read real column values,
  // not row counts: the organisation row always exists, so presence proves
  // nothing about whether anyone has configured it.
  const [{ data: org }, { data: branch }, { data: workspace }] = await Promise.all([
    supabase.from("organizations").select("name, legal_name, business_type").maybeSingle(),
    supabase.from("branches").select("currency, timezone, logo_url").limit(1).maybeSingle(),
    supabase.from("public_workspaces").select("logo_url, primary_color, contact_email").limit(1).maybeSingle(),
  ]);
  if (org) {
    out["/admin/hotel-information"] =
      org.name && org.legal_name && org.business_type ? "configured" : "needs-setup";
  }
  if (branch) {
    out["/admin/regional"] = branch.currency && branch.timezone ? "configured" : "needs-setup";
  }
  const branded = Boolean(workspace?.logo_url ?? branch?.logo_url) && Boolean(workspace?.primary_color);
  out["/admin/brand-identity"] = branded ? "configured" : "needs-setup";
  out["/admin/app-branding"] = branded ? "configured" : "needs-setup";
  out["/admin/dashboard-appearance"] = branded ? "configured" : "needs-setup";


  // Finance calendar: a financial year alone does not let anyone post — the
  // periods dated inside it are what the posting engine resolves against, so
  // a year without periods reads as "attention", not "configured".
  const [years, periods] = await Promise.all([countOf("financial_years"), countOf("accounting_periods")]);
  if (years !== null && periods !== null) {
    out["/admin/finance-periods"] =
      years === 0 ? "needs-setup" : periods === 0 ? "attention" : "configured";
  }

  // Integrations: a sandbox-only or unhealthy connection is not "configured" —
  // it is exactly the case an operator needs surfaced.
  const { data: connections, error: connectionsError } = await supabase
    .from("integration_connections")
    .select("status, environment, health");
  if (!connectionsError) {
    const rows = connections ?? [];
    let status: SettingsStatus = "needs-setup";
    if (rows.length) {
      const live = rows.filter((r) => r.environment === "production" && r.health === "healthy");
      status = live.length ? "configured" : "attention";
    }
    out["/platform/integrations"] = status;
    out["/automation/providers"] = status;
  }

  // Inline panels: the saved organisation-wide settings row is the evidence.
  const { data: systemSettings, error: settingsError } = await supabase
    .from("system_settings")
    .select("settings")
    .maybeSingle();
  if (!settingsError) {
    const saved = (systemSettings?.settings ?? null) as Record<string, unknown> | null;
    const has = (...keys: string[]) => Boolean(saved) && keys.every((k) => saved![k] !== undefined);
    out["panel:operations"] = has("checkInTime", "checkOutTime") ? "configured" : "needs-setup";
    out["panel:numbering"] = has("invoicePrefix", "receiptPrefix") ? "configured" : "needs-setup";
    out["panel:approvals"] = has("discountThreshold", "purchaseThreshold") ? "configured" : "needs-setup";
    // Security is the one surface where defaults are not good enough: an
    // unsaved policy is flagged as needing attention, not merely setup.
    out["panel:security"] = has("passwordMinLength", "sessionTimeoutMinutes")
      ? "configured"
      : "attention";
  }

  return out;
}

export function useSettingsStatuses(enabled: boolean) {
  return useQuery({
    queryKey: ["settings-status"],
    enabled,
    staleTime: 60_000,
    queryFn: loadSettingsStatuses,
  });
}

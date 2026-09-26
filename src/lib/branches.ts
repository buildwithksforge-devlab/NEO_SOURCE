import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";
import { scopeLevelFor } from "@/lib/visibility-contract";

/**
 * Single source of truth for properties / branches.
 *
 * Every property shown anywhere in the OS (global selector, admin shell,
 * operational modules) reads from `public.branches` in Supabase. Nothing here
 * seeds, hardcodes or invents a property — the table is the record.
 */
export type BranchRecord = {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  description: string;
  property_type: string;
  address: string;
  city: string;
  state_region: string;
  country: string;
  phone: string;
  email: string;
  timezone: string | null;
  currency: string | null;
  language: string | null;
  operating_hours: string;
  check_in_time: string;
  check_out_time: string;
  status: string;
  is_main: boolean;
  active: boolean;
  logo_url: string | null;
  /** This hotel's own sign-in address, e.g. /h/zuri-crest-hotel-nakuru. */
  portal_slug: string | null;
  /** Whether that hotel-specific entrance is switched on. */
  portal_enabled: boolean | null;
  created_at: string;
  updated_at: string;
};

export type BranchInput = Partial<
  Omit<BranchRecord, "id" | "organization_id" | "created_at" | "updated_at">
>;

export const branchesQueryKey = (organizationId: string | null) => ["branches", organizationId];

/** All branches visible to the signed-in user under RLS (organization scoped). */
export function useBranches() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: branchesQueryKey(organizationId),
    enabled: Boolean(organizationId),
    // The property list is reference data for the whole shell: several screens
    // mount their own consumer within the same second. A short shared freshness
    // window means they read one answer instead of one request each; every
    // property mutation still invalidates this key immediately.
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("branches")
        .select("*")
        .order("is_main", { ascending: false })
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as BranchRecord[];
    },
  });
}

/** A property picker's worth of the shared list — same query, same RLS. */
export type BranchOption = {
  id: string;
  name: string;
  code: string | null;
  is_main: boolean | null;
  active: boolean | null;
};

/**
 * Property options for module selectors.
 *
 * Modules used to run their own `branches` query under a module-specific key,
 * so one page could fetch the identical property list three times. They now
 * project the shared organisation-scoped list instead — identical rows,
 * identical permissions, one request.
 */
export function useBranchOptions(opts?: { activeOnly?: boolean }) {
  const activeOnly = opts?.activeOnly ?? false;
  const query = useBranches();
  const data = useMemo<BranchOption[]>(() => {
    const rows = query.data ?? [];
    return rows
      .filter((b) => (activeOnly ? b.active !== false : true))
      .map((b) => ({
        id: b.id,
        name: b.name,
        code: b.code ?? null,
        is_main: b.is_main ?? null,
        active: b.active ?? null,
      }));
  }, [query.data, activeOnly]);
  return { ...query, data };
}


/**
 * Property scope for the current user.
 *
 * The list of selectable properties comes from the backend effective-access
 * contract (`access.branchIds`), never from a role name and never from "no
 * branch pinned means everything". Only an organisation-scoped user gets the
 * "All Properties" option; everyone else sees exactly the properties they are
 * assigned to, so the selector can never imply reach the database would refuse.
 */
export function useBranchScope() {
  const { profile, can, organizationId, access } = useAuth();
  const { activeBranchId, setActiveBranchId } = useTenant();
  const branchesQuery = useBranches();

  const all = branchesQuery.data ?? [];
  // "All Properties" is a scope, not a convenience: only an organisation-scoped
  // account may select it. Administrative rights alone never widen the reach.
  const orgWide = scopeLevelFor({
    userId: profile?.id ?? null,
    accountType: access.accountType,
    accountStatus: access.accountStatus,
    organizationId: organizationId ?? null,
    accessScope: access.accessScope,
    branchIds: access.branchIds,
    departmentIds: access.departmentIds,
    stationIds: access.stationIds,
    grants: new Set<string>(),
    entitlements: {},
    setupComplete: access.setupComplete,
  }) === "organization";
  const canManage = can("administration", "edit");

  const assigned = useMemo(() => {
    const ids = new Set(access.branchIds);
    if (profile?.branch_id) ids.add(profile.branch_id);
    return ids;
  }, [access.branchIds, profile?.branch_id]);

  const branches = useMemo(
    () => (orgWide ? all : all.filter((b) => assigned.has(b.id))),
    [all, orgWide, assigned],
  );


  // Keep the selection valid: an unauthorized or deleted property falls back,
  // otherwise the stored choice survives navigation and refresh untouched.
  const resolvedId = useMemo(() => {
    if (activeBranchId === "all") return orgWide ? "all" : (branches[0]?.id ?? "all");
    return branches.some((b) => b.id === activeBranchId)
      ? activeBranchId
      : orgWide
        ? "all"
        : (branches[0]?.id ?? "all");
  }, [activeBranchId, branches, orgWide]);

  const activeBranch = branches.find((b) => b.id === resolvedId) ?? null;

  return {
    organizationId,
    loading: branchesQuery.isLoading,
    branches,
    orgWide,
    /** No property assignment at all — screens must say Setup Incomplete. */
    setupIncomplete: !orgWide && branches.length === 0,
    canManage,
    activeBranchId: resolvedId,
    activeBranch,
    setActiveBranchId,
    refetch: branchesQuery.refetch,
  };
}

/** Resolved operating timezone: property → organization → Africa/Nairobi. */
export function useActiveTimezone() {
  const { activeBranch } = useBranchScope();
  const { tenant } = useTenant();
  return activeBranch?.timezone || tenant.regional.timezone || "Africa/Nairobi";
}

function auditContext(profile: { id: string; full_name: string; organization_id: string } | null) {
  return {
    organizationId: profile?.organization_id ?? null,
    userId: profile?.id ?? null,
    userName: profile?.full_name,
    module: "administration",
  };
}

export function useBranchMutations() {
  const { profile, organizationId } = useAuth();
  const qc = useQueryClient();
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["branches"] });
  }, [qc]);

  const create = useMutation({
    mutationFn: async (input: BranchInput) => {
      if (!organizationId) throw new Error("No active organization");
      const code = (input.code ?? "").trim();
      if (code) {
        const { data: dupe } = await supabase
          .from("branches")
          .select("id")
          .eq("organization_id", organizationId)
          .ilike("code", code)
          .maybeSingle();
        if (dupe) throw new Error(`Branch code "${code}" is already used in this organization`);
      }
      // organization_id always comes from the authenticated context, never the form.
      const { data, error } = await supabase
        .from("branches")
        .insert({
          ...input,
          code,
          organization_id: organizationId,
          created_by: profile?.id ?? null,
        } as never)
        .select("*")
        .single();
      if (error) throw error;
      const row = data as unknown as BranchRecord;
      await logAudit({
        ...auditContext(profile),
        action: "branch.created",
        recordId: row.id,
        branchId: row.id,
        newValue: row,
      });
      return row;
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: async ({
      id,
      patch,
      previous,
      action = "branch.updated",
    }: {
      id: string;
      patch: BranchInput;
      previous?: Partial<BranchRecord>;
      action?: string;
    }) => {
      if (patch.code) {
        const { data: dupe } = await supabase
          .from("branches")
          .select("id")
          .eq("organization_id", organizationId ?? "")
          .ilike("code", patch.code.trim())
          .neq("id", id)
          .maybeSingle();
        if (dupe)
          throw new Error(`Branch code "${patch.code}" is already used in this organization`);
      }
      const { error } = await supabase
        .from("branches")
        .update(patch as never)
        .eq("id", id);
      if (error) throw error;
      await logAudit({
        ...auditContext(profile),
        action,
        recordId: id,
        branchId: id,
        previousValue: previous ?? null,
        newValue: patch,
      });
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async ({ id, previous }: { id: string; previous?: Partial<BranchRecord> }) => {
      const { error } = await supabase.from("branches").delete().eq("id", id);
      if (error) throw error;
      await logAudit({
        ...auditContext(profile),
        action: "branch.deleted",
        recordId: id,
        branchId: id,
        previousValue: previous ?? null,
      });
    },
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

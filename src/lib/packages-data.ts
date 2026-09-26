import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useBranchOptions as useSharedBranchOptions } from "@/lib/branches";
import { logAudit } from "@/lib/audit";
import type { Row } from "@/lib/packages";
import { useScopedDepartments } from "@/lib/scoped-options";

// The package allocation schema is broad; generated types are narrowed at call sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export function usePackageCtx() {
  const { organizationId, profile, user } = useAuth();
  const writeBranchId = useWriteBranchId();
  return {
    organizationId,
    branchId: writeBranchId,
    userId: user?.id ?? null,
    userName: (profile as { full_name?: string } | null)?.full_name ?? "",
  };
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["packages"] });
}

/* --------------------------------- reads --------------------------------- */

export function useAllocationRules() {
  const { organizationId } = usePackageCtx();
  return useQuery({
    queryKey: ["packages", "rules", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("package_allocation_rules")
        .select(
          "*, room_types(name), rate_plans(name), meal_plans(code, name), branches(name), corporate_accounts(legal_name), package_allocation_components(*)",
        )
        .order("priority")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export function useAllocations(filters: { from: string; to: string; branchId?: string | null }) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = usePackageCtx();
  return useQuery({
    queryKey: ["packages", "allocations", organizationId, filters.from, filters.to, filters.branchId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(db.from("package_revenue_allocations").select("*, customers(full_name), room_types(name), rate_plans(name), departments(name), chart_of_accounts(code, name)"), "package_revenue_allocations")
        .gte("stay_date", filters.from)
        .lte("stay_date", filters.to)
        .order("stay_date", { ascending: false })
        .limit(500);
      if (filters.branchId) q = q.eq("branch_id", filters.branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export function useMealEntitlements(serviceDate: string, mealPeriod: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = usePackageCtx();
  return useQuery({
    queryKey: ["packages", "entitlements", organizationId, serviceDate, mealPeriod, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(db.from("package_meal_entitlements").select("*, customers(full_name), rooms(room_number)"), "package_meal_entitlements")
        .eq("service_date", serviceDate)
        .order("meal_period")
        .limit(500);
      if (mealPeriod !== "all") q = q.eq("meal_period", mealPeriod);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export function useAllocationReport(from: string, to: string, branchId: string | null) {
  const { organizationId } = usePackageCtx();
  return useQuery({
    queryKey: ["packages", "report", organizationId, from, to, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "pkg_allocation_report", {
        _branch: branchId,
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
  });
}

/* ------------------------------- mutations ------------------------------- */

export function useSaveRule() {
  const ctx = usePackageCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string | null; values: Row }) => {
      const payload: Row = { ...values, organization_id: ctx.organizationId };
      const query = id
        ? db.from("package_allocation_rules").update(values).eq("id", id)
        : db.from("package_allocation_rules").insert({ ...payload, created_by: ctx.userId });
      const { data, error } = await query.select().single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.package_rule.saved",
        module: "finance",
        recordId: ((data as Row)["id"] as string | undefined) ?? null,
        newValue: data,
      });
      invalidate();
      toast.success("Allocation rule saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSaveComponent() {
  const ctx = usePackageCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string | null; values: Row }) => {
      const query = id
        ? db.from("package_allocation_components").update(values).eq("id", id)
        : db
            .from("package_allocation_components")
            .insert({ ...values, organization_id: ctx.organizationId });
      const { data, error } = await query.select().single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Component saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteComponent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("package_allocation_components").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Component removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Activation is refused by the database unless the components equal the package price. */
export function useSetRuleStatus() {
  const ctx = usePackageCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { data, error } = await db
        .from("package_allocation_rules")
        .update({ status })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.package_rule.status_changed",
        module: "finance",
        recordId: ((data as Row)["id"] as string | undefined) ?? null,
        newValue: data,
      });
      invalidate();
      toast.success(`Rule ${String((data as Row)["status"])}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAllocateCharge() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (folioLineId: string) => {
      const { data, error } = await guardedRpc(db, "pkg_allocate_folio_line", { _line: folioLineId, _source: "manual" });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (data) => {
      invalidate();
      const n = Number((data as Row)?.["allocated"] ?? 0);
      toast[n > 0 ? "success" : "info"](
        n > 0 ? `Allocated across ${n} component(s)` : String((data as Row)?.["reason"] ?? "Nothing to allocate"),
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReverseAllocations() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ folioLineId, reason }: { folioLineId: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "pkg_reverse_allocations", { _line: folioLineId, _reason: reason });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Allocations reversed — original postings preserved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecalculateAllocations() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ folioLineId, reason }: { folioLineId: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "pkg_reallocate_folio_line", { _line: folioLineId, _reason: reason });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Allocations recalculated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateEntitlement() {
  const ctx = usePackageCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status: string; notes?: string }) => {
      const { data, error } = await db
        .from("package_meal_entitlements")
        .update({
          status,
          notes: notes ?? null,
          consumed_at: status === "consumed" ? new Date().toISOString() : null,
          recorded_by: ctx.userId,
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Meal entitlement updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDepartmentOptions() {
  const departments = useScopedDepartments();
  return { ...departments, data: departments.data ?? [] };
}

/** Packages property picker — projects the shared organisation-scoped list. */
export function useBranchOptions() {
  return useSharedBranchOptions();
}


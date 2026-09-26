/**
 * Canonical workforce projection.
 *
 * One source of truth for "who works here". Every surface that shows staff
 * numbers or picks a person — HR, Users, Delivery, dashboards and assignment
 * dropdowns — reads this module so the figures can never disagree again.
 *
 * People come from `employees` (the roster). Login accounts (`profiles`) are
 * an access record, not a person, so they are reported separately and never
 * silently counted as staff.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export type WorkforceSummary = {
  authorised: boolean;
  branch_id: string | null;
  /** People on the roster in scope, excluding exited and terminated records. */
  employees_active: number;
  employees_total: number;
  /** Login accounts in the workspace — an access figure, not a headcount. */
  accounts_active: number;
  employees_without_account: number;
  accounts_without_employee: number;
};

export type WorkforcePerson = {
  employee_id: string;
  profile_id: string | null;
  full_name: string;
  job_title: string | null;
  branch_id: string | null;
  branch_name: string | null;
  department_id: string | null;
  department_name: string | null;
  station_id: string | null;
  employment_status: string;
  has_account: boolean;
};

const EMPTY_SUMMARY: WorkforceSummary = {
  authorised: false,
  branch_id: null,
  employees_active: 0,
  employees_total: 0,
  accounts_active: 0,
  employees_without_account: 0,
  accounts_without_employee: 0,
};

/** Headline workforce figures for the active property (or the whole workspace). */
export function useWorkforceSummary(branchOverride?: string | null) {
  const { branchId } = useActivePropertyFilter();
  const scope = branchOverride === undefined ? branchId : branchOverride;

  const query = useQuery({
    queryKey: ["workforce", "summary", scope ?? "all"],
    queryFn: async (): Promise<WorkforceSummary> => {
      const { data, error } = await guardedRpc(supabase, "neo_workforce_summary", {
        _branch: scope,
      });
      if (error) throw new Error(error.message);
      return { ...EMPTY_SUMMARY, ...((data ?? {}) as Partial<WorkforceSummary>) };
    },
  });

  return {
    ...query,
    summary: query.data ?? null,
    /** Never invent a number: unresolved scope reports null, not zero. */
    headcount: query.data?.authorised ? query.data.employees_active : null,
  };
}

/**
 * The canonical people list for assignment dropdowns and directories.
 * Always property-scoped; optionally narrowed to one department.
 */
export function useWorkforcePeople(options?: { departmentId?: string | null; branchId?: string | null }) {
  const { branchId } = useActivePropertyFilter();
  const scope = options?.branchId === undefined ? branchId : options.branchId;
  const department = options?.departmentId ?? null;

  const query = useQuery({
    queryKey: ["workforce", "people", scope ?? "all", department ?? "all"],
    queryFn: async (): Promise<WorkforcePerson[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_workforce_people", {
        _branch: scope,
        _department: department,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as WorkforcePerson[];
    },
  });

  const options_ = useMemo(
    () =>
      (query.data ?? []).map((p) => ({
        value: p.employee_id,
        profileId: p.profile_id,
        label: p.full_name,
        hint: [p.job_title, p.department_name].filter(Boolean).join(" · ") || null,
        hasAccount: p.has_account,
      })),
    [query.data],
  );

  return { ...query, people: query.data ?? [], options: options_ };
}

/**
 * Explains a staff figure so screens never present accounts as people.
 * Used by dashboards and HR to describe exactly what was counted.
 */
export function describeWorkforceScope(summary: WorkforceSummary | null, propertyName?: string | null): string {
  if (!summary?.authorised) return "Workforce figures are not available for your access.";
  const where = summary.branch_id ? (propertyName ?? "the selected property") : "all properties";
  return `${summary.employees_active} on the roster in ${where} · ${summary.accounts_active} staff accounts in the workspace`;
}

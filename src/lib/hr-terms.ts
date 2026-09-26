/**
 * Employment terms and the company's position grades.
 *
 * Creating an employee establishes the person. Employment terms establish the
 * *engagement*: when they joined, on what basis, at which grade, under which
 * contract and probation, reporting to whom, in which department, property and
 * station. Movements then change those facts later with an effective date,
 * keeping the previous value in the employee's history rather than overwriting
 * it.
 *
 * Grades are configured once per organisation so a promotion moves someone
 * between real company grades instead of free text nobody can compare.
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useHrInvalidate, useHrList } from "@/lib/hr-data";
import type { Row } from "@/lib/hr";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

/** How the employee is engaged. Kept in one place so every screen agrees. */
export const GENDER_OPTIONS = [
  { key: "female", label: "Female" },
  { key: "male", label: "Male" },
  { key: "other", label: "Other" },
  { key: "undisclosed", label: "Prefer not to say" },
] as const;

/** Who a leave policy applies to. */
export const LEAVE_GENDER_SCOPES = [
  { key: "any", label: "Everyone" },
  { key: "female", label: "Female staff only" },
  { key: "male", label: "Male staff only" },
] as const;

/* ----------------------------- position grades ---------------------------- */

export function usePositionGrades(includeInactive = false) {
  return useHrList(
    "position_grades",
    "id, code, name, sort_order, active, notes",
    (q) => {
      const out = q.order("sort_order").order("code");
      return includeInactive ? out : out.eq("active", true);
    },
    [includeInactive ? "all" : "active"],
  );
}

/** The label to show for a stored grade code. */
export function gradeLabel(grades: Row[], code: unknown): string {
  const value = String(code ?? "").trim();
  if (!value) return "—";
  const match = grades.find((g) => String(g["code"]).toLowerCase() === value.toLowerCase());
  return match ? `${String(match["code"])} — ${String(match["name"])}` : value;
}

/* --------------------------- stations for a property ---------------------- */

export function useStationsLookup(branchId?: string | null) {
  return useHrList(
    "operational_stations",
    "id, name, branch_id",
    (q) => {
      const out = q.order("name");
      return branchId ? out.eq("branch_id", branchId) : out;
    },
    [branchId ?? "all"],
  );
}

/* ----------------------------- employment terms --------------------------- */

export type EmploymentTermsInput = {
  employeeId: string;
  employmentDate?: string | null;
  employmentType?: string | null;
  positionGrade?: string | null;
  contractStart?: string | null;
  contractEnd?: string | null;
  probationStart?: string | null;
  probationEnd?: string | null;
  reportingManagerId?: string | null;
  departmentId?: string | null;
  branchId?: string | null;
  stationId?: string | null;
  jobTitle?: string | null;
  gender?: string | null;
  reason?: string | null;
};

const clean = (value: string | null | undefined) => {
  const v = (value ?? "").trim();
  return v === "" ? null : v;
};

/**
 * Establish or correct the starting employment record. The database validates
 * the grade against the configured list, refuses impossible dates and writes
 * the change to the employee's dated history.
 */
export function useSetEmploymentTerms() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: EmploymentTermsInput) => {
      const { data, error } = await guardedRpc(db, "neo_hr_employment_terms", {
        _employee: input.employeeId,
        _employment_date: clean(input.employmentDate),
        _employment_type: clean(input.employmentType),
        _position_grade: clean(input.positionGrade),
        _contract_start: clean(input.contractStart),
        _contract_end: clean(input.contractEnd),
        _probation_start: clean(input.probationStart),
        _probation_end: clean(input.probationEnd),
        _reporting_manager: clean(input.reportingManagerId),
        _department: clean(input.departmentId),
        _branch: clean(input.branchId),
        _station: clean(input.stationId),
        _job_title: clean(input.jobTitle),
        _gender: clean(input.gender),
        _reason: clean(input.reason),
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Employment terms recorded on the employee's file");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

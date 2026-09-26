/**
 * Payroll money layer.
 *
 * HR enters each person's real pay on their profile; Finance chooses which
 * accounts payroll lands in. Nothing here invents an amount or an account —
 * a period can only be posted once every employee has a pay record and every
 * account it needs has been chosen.
 */

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { useHrCtx, useHrInvalidate } from "@/lib/hr-data";
import type { Row } from "@/lib/hr";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

export type PayrollComputationRow = {
  employee_id: string;
  full_name: string;
  branch_id: string | null;
  currency: string;
  pay_frequency: string;
  base_pay: number;
  allowances: number;
  bonuses: number;
  reimbursements: number;
  deductions: number;
  gross_pay: number;
  net_pay: number;
  missing_compensation: boolean;
};

/* --------------------------- employee pay records ------------------------ */

export function useEmployeeCompensation(employeeId?: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "employee_compensation", organizationId, employeeId ?? ""],
    enabled: Boolean(organizationId) && Boolean(employeeId),
    queryFn: async () => {
      const { data, error } = await db
        .from("employee_compensation")
        .select("*")
        .eq("employee_id", employeeId)
        .order("effective_from", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export function useSaveCompensation() {
  const ctx = useHrCtx();
  const invalidate = useHrInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      employee_id: string;
      branch_id?: string | null;
      effective_from: string;
      pay_frequency: string;
      base_amount: number;
      currency: string;
      notes?: string | null;
    }) => {
      const { id, ...values } = input;
      if (id) {
        const { data, error } = await db
          .from("employee_compensation")
          .update(values)
          .eq("id", id)
          .select()
          .single();
        if (error) throw error;
        return data as Row;
      }
      const { data, error } = await db
        .from("employee_compensation")
        .insert({ organization_id: ctx.organization_id, created_by: ctx.userId, ...values })
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data, input) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ["hr", "employee_compensation"] });
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: input.id ? "hr.compensation.updated" : "hr.compensation.recorded",
        module: "human-resources",
        recordId: (data as Row)?.["id"] ?? null,
        newValue: { employee_id: input.employee_id, effective_from: input.effective_from },
        branchId: ctx.branch_id,
      });
      toast.success("Pay record saved");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* --------------------------- posting account setup ----------------------- */

export function usePayrollPostingSettings(branchId?: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "payroll_posting_settings", organizationId, branchId ?? "org"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db.from("payroll_posting_settings").select("*");
      if (error) throw error;
      const list = (data ?? []) as Row[];
      return (
        list.find((r) => (r["branch_id"] ?? null) === (branchId ?? null)) ??
        list.find((r) => r["branch_id"] == null) ??
        null
      );
    },
  });
}

export function usePostableAccounts() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "postable_accounts", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("chart_of_accounts")
        .select("id, code, name, category")
        .eq("postable", true)
        .eq("active", true)
        .order("code");
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export function useSavePayrollPostingSettings() {
  const ctx = useHrCtx();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id?: string; branch_id: string | null; accounts: Row }) => {
      if (input.id) {
        const { error } = await db
          .from("payroll_posting_settings")
          .update(input.accounts)
          .eq("id", input.id);
        if (error) throw error;
        return input.id;
      }
      const { data, error } = await db
        .from("payroll_posting_settings")
        .insert({
          organization_id: ctx.organization_id,
          branch_id: input.branch_id,
          created_by: ctx.userId,
          ...input.accounts,
        })
        .select("id")
        .single();
      if (error) throw error;
      return String((data as Row)["id"]);
    },
    onSuccess: async (id, input) => {
      void qc.invalidateQueries({ queryKey: ["hr", "payroll_posting_settings"] });
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "hr.payroll.accounts_configured",
        module: "human-resources",
        recordId: id,
        newValue: input.accounts,
        branchId: input.branch_id,
      });
      toast.success("Payroll accounts saved");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------- how a person is paid -------------------------- */

/** The one payment record for an employee, or null when none is set up yet. */
export function useEmployeePaymentDetails(employeeId?: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "employee_payment_details", organizationId, employeeId ?? ""],
    enabled: Boolean(organizationId) && Boolean(employeeId),
    queryFn: async () => {
      const { data, error } = await db
        .from("employee_payment_details")
        .select("*")
        .eq("employee_id", employeeId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

export function useSavePaymentDetails() {
  const ctx = useHrCtx();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string | undefined;
      employee_id: string;
      branch_id: string | null;
      payment_method: string;
      bank_name: string | null;
      bank_branch: string | null;
      account_name: string | null;
      account_number: string | null;
      mobile_money_number: string | null;
      notes: string | null;
    }) => {
      const { id, ...values } = input;
      if (id) {
        const { error } = await db.from("employee_payment_details").update(values).eq("id", id);
        if (error) throw error;
        return id;
      }
      const { data, error } = await db
        .from("employee_payment_details")
        .insert({ organization_id: ctx.organization_id, created_by: ctx.userId, ...values })
        .select("id")
        .single();
      if (error) throw error;
      return String((data as Row)["id"]);
    },
    onSuccess: async (id, input) => {
      void qc.invalidateQueries({ queryKey: ["hr", "employee_payment_details"] });
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "hr.payroll.payment_details_saved",
        module: "human-resources",
        recordId: id,
        newValue: { employee_id: input.employee_id, payment_method: input.payment_method },
        branchId: input.branch_id,
      });
      toast.success("Payment details saved");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Put a person into payroll, or take them out, from a stated date. */
export function useSetPayrollEnrolment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employee_id: string;
      active: boolean;
      effective_from: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_hr_set_payroll_enrolment", {
        _employee: input.employee_id,
        _active: input.active,
        _effective: input.effective_from,
      });
      if (error) throw error;
      return data as { ok: boolean; active: boolean };
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["hr"] });
      toast.success(result?.active ? "Enrolled in payroll" : "Removed from payroll");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ---------------------------- payroll enrolment -------------------------- */

export type PayrollEnrolmentRow = {
  employee_id: string;
  full_name: string;
  employee_number: string | null;
  job_title: string | null;
  employment_status: string | null;
  payroll_status: string | null;
  branch_id: string | null;
  base_amount: number | null;
  currency: string | null;
  pay_frequency: string | null;
  effective_from: string | null;
};

/**
 * Who is actually set up for payroll.
 *
 * A login account is not payroll enrolment: a person counts as enrolled only
 * when their employee record carries a current pay record. This read joins the
 * two so the gap is visible instead of only surfacing when a period is priced.
 */
export function usePayrollEnrolment() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "payroll_enrolment", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<PayrollEnrolmentRow[]> => {
      const [employees, compensation] = await Promise.all([
        db
          .from("employees")
          .select(
            "id, full_name, employee_number, job_title, employment_status, payroll_status, branch_id",
          )
          .neq("employment_status", "exited")
          .order("full_name"),
        db
          .from("employee_compensation")
          .select("employee_id, base_amount, currency, pay_frequency, effective_from")
          .order("effective_from", { ascending: false }),
      ]);
      if (employees.error) throw employees.error;
      if (compensation.error) throw compensation.error;

      const current = new Map<string, Row>();
      for (const c of (compensation.data ?? []) as Row[]) {
        const key = String(c["employee_id"]);
        if (!current.has(key)) current.set(key, c); // newest effective_from wins
      }
      return ((employees.data ?? []) as Row[]).map((e) => {
        const pay = current.get(String(e["id"])) ?? null;
        return {
          employee_id: String(e["id"]),
          full_name: String(e["full_name"] ?? ""),
          employee_number: (e["employee_number"] as string | null) ?? null,
          job_title: (e["job_title"] as string | null) ?? null,
          employment_status: (e["employment_status"] as string | null) ?? null,
          payroll_status: (e["payroll_status"] as string | null) ?? null,
          branch_id: (e["branch_id"] as string | null) ?? null,
          base_amount: pay ? Number(pay["base_amount"]) : null,
          currency: pay ? String(pay["currency"] ?? "KES") : null,
          pay_frequency: pay ? String(pay["pay_frequency"] ?? "") : null,
          effective_from: pay ? String(pay["effective_from"]) : null,
        };
      });
    },
  });
}

/* ------------------------------ period totals ---------------------------- */

export function usePayrollComputation(periodId?: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "payroll_computation", organizationId, periodId ?? ""],
    enabled: Boolean(organizationId) && Boolean(periodId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_hr_payroll_compute", {
        _period: periodId,
      });
      if (error) throw error;
      return (data ?? []) as PayrollComputationRow[];
    },
  });
}

export function payrollTotals(rows: PayrollComputationRow[]) {
  const sum = (key: keyof PayrollComputationRow) =>
    rows.reduce((total, r) => total + Number(r[key] ?? 0), 0);
  return {
    employees: rows.length,
    missing: rows.filter((r) => r.missing_compensation).length,
    base: sum("base_pay"),
    allowances: sum("allowances"),
    bonuses: sum("bonuses"),
    reimbursements: sum("reimbursements"),
    deductions: sum("deductions"),
    gross: sum("gross_pay"),
    net: sum("net_pay"),
    currency: rows[0]?.currency ?? "KES",
  };
}

/**
 * Every period's figures in one read, so Finance sees a ledger rather than one
 * period at a time. Each period is priced by the same guarded routine that
 * posts it, so the ledger and the posting can never disagree.
 */
export function usePayrollLedger(periods: Row[]) {
  const { organizationId } = useAuth();
  const results = useQueries({
    queries: periods.map((p) => ({
      queryKey: ["hr", "payroll_computation", organizationId, String(p["id"])],
      enabled: Boolean(organizationId),
      queryFn: async () => {
        const { data, error } = await guardedRpc(db, "neo_hr_payroll_compute", {
          _period: String(p["id"]),
        });
        if (error) throw error;
        return (data ?? []) as PayrollComputationRow[];
      },
    })),
  });

  return {
    byPeriod: periods.map((period, i) => ({
      period,
      rows: (results[i]?.data ?? []) as PayrollComputationRow[],
    })),
    isLoading: results.some((r) => r.isLoading),
    error: (results.find((r) => r.error)?.error as Error | undefined) ?? null,
    refetch: () => results.forEach((r) => void r.refetch()),
  };
}

/** Turn automatic posting on or off for the accounts this period uses. */
export function useSetPayrollAutoPost() {
  const ctx = useHrCtx();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id?: string; branch_id: string | null; enabled: boolean }) => {
      const values = {
        auto_post_enabled: input.enabled,
        auto_post_updated_at: new Date().toISOString(),
        auto_post_updated_by: ctx.userId,
      };
      if (input.id) {
        const { error } = await db
          .from("payroll_posting_settings")
          .update(values)
          .eq("id", input.id);
        if (error) throw error;
        return input.id;
      }
      const { data, error } = await db
        .from("payroll_posting_settings")
        .insert({
          organization_id: ctx.organization_id,
          branch_id: input.branch_id,
          created_by: ctx.userId,
          ...values,
        })
        .select("id")
        .single();
      if (error) throw error;
      return String((data as Row)["id"]);
    },
    onSuccess: async (id, input) => {
      void qc.invalidateQueries({ queryKey: ["hr", "payroll_posting_settings"] });
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: input.enabled ? "hr.payroll.autopost_enabled" : "hr.payroll.autopost_disabled",
        module: "human-resources",
        recordId: id,
        newValue: { auto_post_enabled: input.enabled },
        branchId: input.branch_id,
      });
      toast.success(
        input.enabled
          ? "Automatic posting is on — an approved period posts itself"
          : "Automatic posting is off — payroll posts only when you press the button",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function usePostPayroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (periodId: string) => {
      const { data, error } = await guardedRpc(db, "neo_hr_payroll_post", { _period: periodId });
      if (error) throw error;
      return data as { journal_id: string; employees: number; net: number; duplicate_prevented: boolean };
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["hr"] });
      void qc.invalidateQueries({ queryKey: ["finance"] });
      toast.success(
        result?.duplicate_prevented
          ? "This period was already posted — the existing journal is unchanged"
          : `Posted ${result?.employees ?? 0} employees to the finance books`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

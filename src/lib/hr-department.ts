/**
 * Human Resources department layer.
 *
 * HR is a one-role department: the HR Manager owns the employment lifecycle —
 * the official employee file, documents, onboarding, movements, employee
 * relations and HR office supplies. They never grant system permissions; that
 * stays with System Administration. Every change writes history rather than
 * overwriting the previous record.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedDepartmentByKey } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The HR trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type HrRow = Record<string, unknown>;

export const DOCUMENT_CATEGORIES = [
  "cv",
  "national-id",
  "passport",
  "kra-pin",
  "nssf",
  "sha-shif",
  "bank-details",
  "employment-contract",
  "appointment-letter",
  "academic-certificate",
  "professional-certificate",
  "training-certificate",
  "police-clearance",
  "signed-policy",
  "medical-fitness",
  "other",
] as const;

export const MOVEMENT_TYPES = [
  { key: "promotion", label: "Promotion" },
  { key: "transfer", label: "Transfer" },
  { key: "role-change", label: "Role change" },
  { key: "confirmation", label: "Probation confirmation" },
  { key: "status-change", label: "Employment status change" },
] as const;

export const HR_SUPPLY_SUGGESTIONS = [
  "Stationery",
  "Employee forms",
  "Personnel files",
  "Printing supplies",
  "Training materials",
  "HR office consumables",
] as const;

export function str(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Document expiry state, used for the HR alerting surface. */
export function documentExpiry(expiry: unknown): {
  state: "none" | "valid" | "expiring" | "expired";
  days: number | null;
} {
  const raw = expiry ? String(expiry) : "";
  if (!raw) return { state: "none", days: null };
  const due = new Date(raw + "T00:00:00Z").getTime();
  if (!Number.isFinite(due)) return { state: "none", days: null };
  const days = Math.round((due - Date.now()) / 86_400_000);
  if (days < 0) return { state: "expired", days };
  if (days <= 45) return { state: "expiring", days };
  return { state: "valid", days };
}

export function useHrContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

function useHrInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["hr-department"] });
    void qc.invalidateQueries({ queryKey: ["hr"] });
  };
}

export function useHrDepartment() {
  return useScopedDepartmentByKey("human.?resource|^hr$|people");
}

/* ------------------------------------------------------------------ *
 * Employee documents — versioned, never deleted
 * ------------------------------------------------------------------ */

export function useEmployeeDocuments(employeeId: string | null, includeSuperseded = false) {
  const { organizationId } = useHrContext();
  return useQuery({
    queryKey: ["hr-department", "documents", organizationId, employeeId, includeSuperseded],
    enabled: Boolean(organizationId) && Boolean(employeeId),
    queryFn: async () => {
      let q = db
        .from("employee_documents")
        .select("*")
        .eq("employee_id", employeeId)
        .order("created_at", { ascending: false })
        .limit(300);
      if (!includeSuperseded) q = q.eq("status", "active");
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as HrRow[];
    },
  });
}

/** Active documents across the organisation, newest first — the compliance view. */
export function useAllEmployeeDocuments() {
  const { organizationId } = useHrContext();
  return useQuery({
    queryKey: ["hr-department", "documents-all", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("employee_documents")
        .select("*, employees:employee_id(id, full_name, employee_number, job_title)")
        .eq("status", "active")
        .order("expiry_date", { ascending: true, nullsFirst: false })
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as HrRow[];
    },
  });
}

export function useRecordEmployeeDocument() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: {
      employeeId: string;
      category: string;
      title: string;
      storagePath?: string | null;
      issueDate?: string | null;
      expiryDate?: string | null;
      confidentiality?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_hr_document_record", {
        _employee: input.employeeId,
        _category: input.category,
        _title: input.title,
        _storage_path: input.storagePath ?? null,
        _issue_date: input.issueDate || null,
        _expiry_date: input.expiryDate || null,
        _confidentiality: input.confidentiality ?? "restricted",
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as HrRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Document recorded as version ${str(data["version"], "1")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Employment movements — promotions, transfers, role changes
 * ------------------------------------------------------------------ */

export function useEmploymentHistory(employeeId: string | null) {
  const { organizationId } = useHrContext();
  return useQuery({
    queryKey: ["hr-department", "employment-history", organizationId, employeeId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("employment_history")
        .select("*, employees:employee_id(id, full_name, employee_number)")
        .order("effective_date", { ascending: false })
        .limit(300);
      if (employeeId) q = q.eq("employee_id", employeeId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as HrRow[];
    },
  });
}

export function useRecordEmploymentMovement() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: {
      employeeId: string;
      changeType: string;
      effectiveDate?: string | null;
      reason?: string | null;
      branchId?: string | null;
      departmentId?: string | null;
      jobTitle?: string | null;
    positionGrade?: string | null;
      reportingManagerId?: string | null;
      employmentStatus?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_hr_employee_movement", {
        _employee: input.employeeId,
        _change_type: input.changeType,
        _effective_date: input.effectiveDate || null,
        _reason: input.reason ?? null,
        _branch: input.branchId || null,
        _department: input.departmentId || null,
        _job_title: input.jobTitle || null,
      _position_grade: input.positionGrade || null,
        _reporting_manager: input.reportingManagerId || null,
        _employment_status: input.employmentStatus || null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as HrRow;
    },
    onSuccess: (data) => {
      invalidate();
      if (data["access_review_required"]) {
        toast.success("Movement recorded. System access review sent to the administrator.");
      } else {
        toast.success("Employment movement recorded in the employee's history");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Employee relations — confidential HR cases
 * ------------------------------------------------------------------ */

export function useHrCases(kind: "disciplinary" | "grievance") {
  const { organizationId, branchId } = useHrContext();
  return useQuery({
    queryKey: ["hr-department", "cases", kind, organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const table = kind === "disciplinary" ? "disciplinary_cases" : "grievance_cases";
      const employeeCol = kind === "disciplinary" ? "employee_id" : "raised_by_employee_id";
      let q = db
        .from(table)
        .select(`*, employees:${employeeCol}(id, full_name, employee_number, job_title)`)
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as HrRow[];
    },
  });
}

export function useOpenHrCase() {
  const invalidate = useHrInvalidate();
  const { branchId } = useHrContext();
  return useMutation({
    mutationFn: async (input: {
      kind: "disciplinary" | "grievance";
      employeeId: string;
      subject: string;
      details?: string;
      caseType?: string;
      incidentDate?: string | null;
      departmentId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_hr_case_open", {
        _kind: input.kind,
        _employee: input.employeeId,
        _subject: input.subject,
        _details: input.details ?? null,
        _case_type: input.caseType ?? "general",
        _incident_date: input.incidentDate || null,
        _branch: branchId ?? null,
        _department: input.departmentId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as HrRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Case ${str(data["case_number"], "opened")} recorded confidentially`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewHrCase() {
  const invalidate = useHrInvalidate();

  return useMutation({
    mutationFn: async (input: {
      kind: "disciplinary" | "grievance";
      caseId: string;
      status: string;
      notes?: string;
      outcome?: string;
    }) => {
      const table =
        input.kind === "disciplinary"
          ? "disciplinary_cases"
          : "grievance_cases";

      const { data: rpcResult, error: rpcError } = await guardedRpc(
        db,
        "neo_hr_case_review",
        {
          _kind: input.kind,
          _case: input.caseId,
          _status: input.status,
          _notes: input.notes ?? null,
          _outcome: input.outcome ?? null,
        },
      );

      if (rpcError) {
        throw new Error(rpcError.message);
      }

      // An RPC can return an application-level rejection without
      // a transport error. Do not report success in that case.
      if (
        rpcResult &&
        typeof rpcResult === "object" &&
        !Array.isArray(rpcResult)
      ) {
        const result = rpcResult as Record<string, unknown>;

        if (result["ok"] === false) {
          throw new Error(
            String(
              result["detail"] ??
                result["reason"] ??
                "HR case review was rejected.",
            ),
          );
        }
      }

      // Verify the persisted database state.
      // A successful HTTP response alone is not sufficient.
      const outcomeColumn =
        input.kind === "disciplinary"
          ? "resolution"
          : "outcome";

      const { data: persisted, error: readError } = await db
        .from(table)
        .select(`id, status, ${outcomeColumn}`)
        .eq("id", input.caseId)
        .maybeSingle();

      if (readError) {
        throw new Error(
          `Unable to verify the HR case update: ${readError.message}`,
        );
      }

      if (!persisted) {
        throw new Error(
          "HR case update could not be verified. The record is unavailable or access was denied.",
        );
      }

      const actualStatus = String(persisted["status"] ?? "");

      if (actualStatus !== input.status) {
        throw new Error(
          `HR case did not advance. Expected "${input.status}", but the database still shows "${actualStatus}".`,
        );
      }

      if (
        input.status === "resolved" &&
        input.outcome?.trim() &&
        String(persisted[outcomeColumn] ?? "").trim() !== input.outcome.trim()
      ) {
        throw new Error(
          "The case status changed, but its recorded outcome does not match the submitted resolution. HR must review the case.",
        );
      }

      return {
        caseId: input.caseId,
        kind: input.kind,
        status: actualStatus,
      };
    },

    onSuccess: (result) => {
      invalidate();

      toast.success(
        result.status === "resolved"
          ? "HR case resolved and verified."
          : "HR case status updated and verified.",
      );
    },

    onError: (error: Error) => {
      invalidate();
      toast.error(error.message);
    },
  });
}
/* ------------------------------------------------------------------ *
 * Onboarding
 * ------------------------------------------------------------------ */

export function useOnboardingAssignments(status: "open" | "all" = "open") {
  const { organizationId } = useHrContext();
  return useQuery({
    queryKey: ["hr-department", "onboarding", organizationId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("onboarding_assignments")
        .select("*, employees:employee_id(id, full_name, employee_number, job_title, employment_date)")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(300);
      if (status === "open") q = q.neq("status", "completed");
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as HrRow[];
    },
  });
}

export function useUpdateOnboardingAssignment() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: { id: string; status: string; blocker?: string | null }) => {
      const { error } = await db
        .from("onboarding_assignments")
        .update({
          status: input.status,
          blocker: input.blocker ?? null,
          completed_at: input.status === "completed" ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Onboarding step updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * HR office supplies — requested from Stores, never self-issued
 * ------------------------------------------------------------------ */

export function useHrStockNeeds(status = "all") {
  const { organizationId, branchId } = useHrContext();
  return useQuery({
    queryKey: ["hr-department", "stock-needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "human-resources")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as HrRow[];
    },
  });
}

export function useReportHrStockNeed() {
  const invalidate = useHrInvalidate();
  const { branchId } = useHrContext();
  const department = useHrDepartment();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      quantity: number;
      unit?: string;
      priority?: string;
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_department_stock_need_create", {
        _item: input.item,
        _quantity: input.quantity,
        _unit: input.unit ?? "unit",
        _priority: input.priority ?? "normal",
        _notes: input.notes ?? null,
        _module: "human-resources",
        _department: department.data?.["id"] ? String(department.data["id"]) : null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("HR supply need recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewHrStockNeed() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: {
      needId: string;
      decision: "acknowledge" | "requisition" | "decline" | "close";
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_department_stock_need_review", {
        _need: input.needId,
        _decision: input.decision,
        _notes: input.notes ?? null,
        _requisition: null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as HrRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Supply need ${str(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * HR intelligence counters used by the HR dashboard
 * ------------------------------------------------------------------ */

export function useHrDocumentAlerts() {
  const documents = useAllEmployeeDocuments();
  const rows = (documents.data ?? []) as HrRow[];
  const expiring = rows.filter((r) => documentExpiry(r["expiry_date"]).state === "expiring");
  const expired = rows.filter((r) => documentExpiry(r["expiry_date"]).state === "expired");
  return { ...documents, rows, expiring, expired };
}

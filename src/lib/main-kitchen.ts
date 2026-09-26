/**
 * Main Kitchen department layer.
 *
 * The department runs on four tiers and the boundaries below mirror that
 * contract exactly:
 *
 *  - The Kitchen Manager / Head Chef owns the whole Main Kitchen and is the
 *    only role that may turn reported needs into a Stores requisition.
 *  - The Hot Kitchen Supervisor coordinates production, assigns chefs and
 *    stewards, reviews wastage and breakages, and consolidates stock needs for
 *    the Head Chef — never requisitioning directly.
 *  - Hot Kitchen Chefs see only the items assigned to them: recipe, portion,
 *    modifiers and allergy notes. No bill, no payment, no guest money.
 *  - Kitchen Stewards see only their own cleaning tasks, the hygiene and
 *    sanitation checklists, and breakage reporting.
 *
 * Every write goes through a security-definer routine so the database, not the
 * screen, enforces this.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The kitchen trail spans several generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type KitchenRow = Record<string, unknown>;

export const HYGIENE_CHECKLISTS: Record<string, string[]> = {
  hygiene: [
    "Hands washed and gloves changed",
    "Uniform and apron clean",
    "Hair covered",
    "No jewellery worn in production",
    "Cuts covered with blue plaster",
  ],
  sanitation: [
    "Work surfaces sanitised",
    "Chopping boards colour-separated",
    "Sinks cleaned and drained",
    "Bins emptied and lined",
    "Floor cleaned and dry",
  ],
  cleaning: [
    "Dishwashing area cleared",
    "Crockery and glassware racked",
    "Cooking equipment wiped down",
    "Extraction filters checked",
    "Store cupboard tidy",
  ],
};

export const BREAKAGE_UNITS = ["piece", "set", "tray", "rack"] as const;

export function kitchenStr(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function kitchenNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function needTone(status: string): "success" | "warning" | "destructive" | "default" {
  if (status === "requisitioned" || status === "closed") return "success";
  if (status === "declined") return "destructive";
  if (status === "acknowledged") return "warning";
  return "default";
}

export function taskTone(status: string): "success" | "warning" | "destructive" | "default" {
  if (status === "completed") return "success";
  if (status === "in-progress") return "warning";
  return "default";
}

export function nextTaskStatus(status: string): "in-progress" | "completed" | null {
  if (status === "completed") return null;
  return status === "in-progress" ? "completed" : "in-progress";
}

export function useMainKitchenContext() {
  const { organizationId, profile, user } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback, userId: user?.id ?? null };
}

function useKitchenInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["main-kitchen"] });
    void qc.invalidateQueries({ queryKey: ["kitchen"] });
  };
}

/* ------------------------------------------------------------------ *
 * Chef — my own assigned work
 * ------------------------------------------------------------------ */

export function useMyKitchenWork() {
  const { organizationId, branchId } = useMainKitchenContext();
  return useQuery({
    queryKey: ["main-kitchen", "my-work", organizationId, branchId],
    enabled: Boolean(organizationId),
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_kitchen_my_work", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      return (data ?? []) as KitchenRow[];
    },
  });
}

export function useAssignChef() {
  const invalidate = useKitchenInvalidate();
  return useMutation({
    mutationFn: async (input: { ticketId: string; chefId: string; itemId?: string | null; reason?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_kitchen_assign_chef", {
        _ticket: input.ticketId,
        _chef: input.chefId,
        _item: input.itemId ?? null,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as KitchenRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Chef assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Stewarding — tasks, hygiene checklists and breakages
 * ------------------------------------------------------------------ */

export function useMyKitchenTasks() {
  const { organizationId, userId } = useMainKitchenContext();
  return useQuery({
    queryKey: ["main-kitchen", "my-tasks", organizationId, userId],
    enabled: Boolean(organizationId && userId),
    queryFn: async () => {
      const { data, error } = await db
        .from("tasks")
        .select("*")
        .eq("assignee_id", userId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return (data ?? []) as KitchenRow[];
    },
  });
}

export function useCreateKitchenTask() {
  const invalidate = useKitchenInvalidate();
  const { branchId } = useMainKitchenContext();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      assigneeId?: string | null;
      description?: string;
      priority?: string;
      dueAt?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_kitchen_task_create", {
        _title: input.title,
        _assignee: input.assigneeId ?? null,
        _description: input.description ?? null,
        _priority: input.priority ?? "normal",
        _due: input.dueAt ?? null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as KitchenRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Kitchen task assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceKitchenTask() {
  const invalidate = useKitchenInvalidate();
  return useMutation({
    mutationFn: async (input: { taskId: string; status: "in-progress" | "completed"; note?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_kitchen_task_advance", {
        _task: input.taskId,
        _status: input.status,
        _note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as KitchenRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Task updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useHygieneChecks() {
  const { organizationId, branchId } = useMainKitchenContext();
  return useQuery({
    queryKey: ["main-kitchen", "hygiene", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db.from("kitchen_hygiene_checks").select("*").order("completed_at", { ascending: false }).limit(100);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as KitchenRow[];
    },
  });
}

export function useSubmitHygieneCheck() {
  const invalidate = useKitchenInvalidate();
  const { branchId } = useMainKitchenContext();
  return useMutation({
    mutationFn: async (input: {
      area: string;
      checkType: string;
      items: { label: string; done: boolean }[];
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_kitchen_hygiene_submit", {
        _area: input.area,
        _check_type: input.checkType,
        _items: input.items,
        _notes: input.notes ?? null,
        _station: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as KitchenRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Checklist submitted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useKitchenBreakages() {
  const { organizationId, branchId } = useMainKitchenContext();
  return useQuery({
    queryKey: ["main-kitchen", "breakages", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db.from("kitchen_breakages").select("*").order("created_at", { ascending: false }).limit(100);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as KitchenRow[];
    },
  });
}

export function useRecordBreakage() {
  const invalidate = useKitchenInvalidate();
  const { branchId } = useMainKitchenContext();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      quantity: number;
      unit?: string;
      estimatedCost?: number | null;
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_kitchen_breakage_record", {
        _item: input.item,
        _quantity: input.quantity,
        _unit: input.unit ?? "piece",
        _estimated_cost: input.estimatedCost ?? null,
        _reason: input.reason ?? null,
        _station: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as KitchenRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Breakage reported");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewBreakage() {
  const invalidate = useKitchenInvalidate();
  return useMutation({
    mutationFn: async (input: {
      breakageId: string;
      decision: "acknowledged" | "written-off" | "rejected";
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_kitchen_breakage_review", {
        _breakage: input.breakageId,
        _decision: input.decision,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as KitchenRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Breakage reviewed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Stock needs — anyone reports, the Head Chef alone requisitions
 * ------------------------------------------------------------------ */

export function useKitchenStockNeeds(status = "all") {
  const { organizationId, branchId } = useMainKitchenContext();
  return useQuery({
    queryKey: ["main-kitchen", "needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "kitchen")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as KitchenRow[];
    },
  });
}

export function useReportKitchenNeed() {
  const invalidate = useKitchenInvalidate();
  const { branchId } = useMainKitchenContext();
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
        _unit: input.unit ?? "kg",
        _priority: input.priority ?? "normal",
        _notes: input.notes ?? null,
        _module: "kitchen",
        _department: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Need sent up to the Head Chef");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewKitchenNeed() {
  const invalidate = useKitchenInvalidate();
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
      return (data ?? {}) as KitchenRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Need updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Head Chef only: consolidate the selected needs into one Stores requisition. */
export function useRequisitionKitchenNeeds() {
  const invalidate = useKitchenInvalidate();
  return useMutation({
    mutationFn: async (input: { needIds: string[]; requiredDate?: string | null; priority?: string; reason?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_kitchen_requisition_from_needs", {
        _needs: input.needIds,
        _required_date: input.requiredDate ?? null,
        _priority: input.priority ?? "normal",
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as KitchenRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Requisition ${kitchenStr(data["request_number"], "")} sent to Stores`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

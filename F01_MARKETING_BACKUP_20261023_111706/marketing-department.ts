/**
 * Marketing department layer.
 *
 * The department has one Marketing Manager who owns strategy, budget, campaigns
 * and every outbound commitment, and Social Media Managers who draft content,
 * keep the publishing calendar and answer social enquiries. A Social Media
 * Manager never approves their own content, never raises a Stores requisition
 * or purchase request directly, and never commits spend — supply needs and
 * content both travel upward to the Marketing Manager.
 *
 * Reads and writes go through the existing authoritative marketing records
 * (campaigns, leads, tasks, department stock needs) plus the content workflow
 * table; this module adds the department-scoped views, not a second source of
 * truth.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedDepartmentByKey } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The marketing trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type MktRow = Record<string, unknown>;

export const MKT_CHANNELS = [
  "instagram",
  "facebook",
  "tiktok",
  "x",
  "linkedin",
  "whatsapp",
  "email",
  "website",
  "other",
] as const;

export const MKT_CONTENT_TYPES = ["post", "story", "reel", "video", "article", "newsletter", "ad"] as const;

export const MKT_CONTENT_STATUSES = [
  "draft",
  "submitted",
  "returned",
  "approved",
  "scheduled",
  "published",
  "rejected",
] as const;

export const MKT_SUPPLY_SUGGESTIONS = [
  "Printed brochures",
  "Roll-up banners",
  "Branded merchandise",
  "Photography props",
  "Stationery",
  "Signage",
] as const;

export function str(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function useMarketingContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

function useMktInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["marketing-department"] });
    void qc.invalidateQueries({ queryKey: ["marketing"] });
    void qc.invalidateQueries({ queryKey: ["crm"] });
  };
}

/** The Marketing department row, used to scope tasks and supply needs. */
export function useMarketingDepartment() {
  return useScopedDepartmentByKey("marketing|brand|communication");
}

/* ------------------------------------------------------------------ *
 * Content workflow — drafted below, approved above
 * ------------------------------------------------------------------ */

export function useMarketingContent(status = "all") {
  const { organizationId, branchId } = useMarketingContext();
  return useQuery({
    queryKey: ["marketing-department", "content", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("marketing_content_items")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as MktRow[];
    },
  });
}

export function useCreateMarketingContent() {
  const invalidate = useMktInvalidate();
  const { organizationId, branchId } = useMarketingContext();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      channel: string;
      contentType?: string;
      body?: string;
      assetUrl?: string;
      campaignId?: string | null;
      plannedFor?: string | null;
    }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (!input.title.trim()) throw new Error("Give the content a title");
      const { data, error } = await db
        .from("marketing_content_items")
        .insert({
          organization_id: organizationId,
          branch_id: branchId ?? null,
          campaign_id: input.campaignId || null,
          channel: input.channel,
          content_type: input.contentType ?? "post",
          title: input.title.trim(),
          body: input.body?.trim() || null,
          asset_url: input.assetUrl?.trim() || null,
          planned_for: input.plannedFor || null,
          status: "draft",
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data as MktRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Content draft saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSubmitMarketingContent() {
  const invalidate = useMktInvalidate();
  return useMutation({
    mutationFn: async (contentId: string) => {
      const { data, error } = await guardedRpc(db, "neo_marketing_content_submit", { _content: contentId });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MktRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Sent to the Marketing Manager for approval");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewMarketingContent() {
  const invalidate = useMktInvalidate();
  return useMutation({
    mutationFn: async (input: {
      contentId: string;
      decision: "approve" | "return" | "reject";
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_marketing_content_review", {
        _content: input.contentId,
        _decision: input.decision,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MktRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Content ${str(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useScheduleMarketingContent() {
  const invalidate = useMktInvalidate();
  return useMutation({
    mutationFn: async (input: { contentId: string; scheduledFor: string }) => {
      if (!input.scheduledFor) throw new Error("Pick a publish date and time");
      const { data, error } = await guardedRpc(db, "neo_marketing_content_schedule", {
        _content: input.contentId,
        _scheduled_for: new Date(input.scheduledFor).toISOString(),
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MktRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Content scheduled");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePublishMarketingContent() {
  const invalidate = useMktInvalidate();
  return useMutation({
    mutationFn: async (input: { contentId: string; reference?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_marketing_content_publish", {
        _content: input.contentId,
        _reference: input.reference ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MktRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Marked as published");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Social enquiries become leads on the one pipeline
 * ------------------------------------------------------------------ */

export function useCreateSocialLead() {
  const invalidate = useMktInvalidate();
  const { organizationId, branchId } = useMarketingContext();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: {
      contactName: string;
      channel: string;
      phone?: string;
      email?: string;
      interest?: string;
      requirements?: string;
      campaignId?: string | null;
    }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (!input.contactName.trim()) throw new Error("Who made the enquiry?");
      if (!input.phone?.trim() && !input.email?.trim()) {
        throw new Error("Capture a phone number or an email so the enquiry can be followed up");
      }
      const { data: seq } = await guardedRpc(db, "next_document_number", { _doc_type: "lead" });
      const { error } = await db.from("leads").insert({
        organization_id: organizationId,
        branch_id: branchId ?? null,
        lead_number: seq ?? null,
        lead_type: "social",
        contact_name: input.contactName.trim(),
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        interest: input.interest?.trim() || null,
        requirements: input.requirements?.trim() || null,
        preferred_channel: input.channel,
        source_label: `Social — ${input.channel}`,
        campaign_id: input.campaignId || null,
        stage: "new",
        created_by: user?.id ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Enquiry logged on the lead pipeline");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Campaigns visible to the department
 * ------------------------------------------------------------------ */

export function useMarketingCampaignOptions() {
  const { organizationId } = useMarketingContext();
  return useQuery({
    queryKey: ["marketing-department", "campaign-options", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("campaigns")
        .select("id,name,status")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return (data ?? []) as MktRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Department tasks
 * ------------------------------------------------------------------ */

export function useMarketingTasks() {
  const { organizationId, branchId } = useMarketingContext();
  const department = useMarketingDepartment();
  const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
  return useQuery({
    queryKey: ["marketing-department", "tasks", organizationId, branchId, departmentId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("tasks")
        .select("*")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(200);
      if (departmentId) q = q.eq("department_id", departmentId);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as MktRow[];
    },
  });
}

export function useCreateMarketingTask() {
  const invalidate = useMktInvalidate();
  const { organizationId, branchId } = useMarketingContext();
  const { user } = useAuth();
  const department = useMarketingDepartment();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      dueAt?: string | null;
      priority?: string;
      description?: string;
    }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (!input.title.trim()) throw new Error("Give the task a title");
      const { error } = await db.from("tasks").insert({
        organization_id: organizationId,
        branch_id: branchId ?? null,
        department_id: department.data?.["id"] ? String(department.data["id"]) : null,
        title: input.title.trim(),
        description: input.description ?? null,
        priority: input.priority ?? "normal",
        status: "open",
        due_at: input.dueAt || null,
        assignee_id: user?.id ?? null,
        created_by: user?.id ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Marketing task created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateMarketingTask() {
  const invalidate = useMktInvalidate();
  return useMutation({
    mutationFn: async (input: { id: string; status: string }) => {
      const { error } = await db
        .from("tasks")
        .update({
          status: input.status,
          completed_at: input.status === "completed" ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Task updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Supply needs — reported by the team, requisitioned by the manager
 * ------------------------------------------------------------------ */

export function useMarketingStockNeeds(status = "all") {
  const { organizationId, branchId } = useMarketingContext();
  return useQuery({
    queryKey: ["marketing-department", "stock-needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "marketing")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as MktRow[];
    },
  });
}

export function useReportMarketingStockNeed() {
  const invalidate = useMktInvalidate();
  const { branchId } = useMarketingContext();
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
        _module: "marketing",
        _department: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Supply need sent to the Marketing Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewMarketingStockNeed() {
  const invalidate = useMktInvalidate();
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
      return (data ?? {}) as MktRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Supply need ${str(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

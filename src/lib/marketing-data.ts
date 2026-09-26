/**
 * Phase 15 — Marketing data layer.
 *
 * Every read is organization-scoped by RLS; nothing here is trusted to enforce
 * tenancy on its own. Sensitive decisions (send eligibility, dashboard metrics)
 * go through SECURITY DEFINER database functions so the browser cannot dictate
 * consent, suppression or audience outcomes.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { ilikeOrFilter } from "@/lib/or-filter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { useScopedWorkerOptions } from "@/lib/scoped-options";
import { useActivePropertyFilter } from "@/lib/branch-filter";

type Row = Record<string, unknown>;

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const KEY = "marketing";

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: [KEY] });
}

/** Audit wrapper supplying tenant + actor context from the signed-in session. */
export function useMarketingAudit() {
  const { user, organizationId, profile } = useAuth();
  return async (
    action: string,
    recordId: string | null,
    newValue?: unknown,
    reason?: string,
    previousValue?: unknown,
  ) => {
    await logAudit({
      organizationId: organizationId ?? null,
      userId: user?.id ?? null,
      userName: profile?.full_name ?? undefined,
      action,
      module: "marketing",
      recordId,
      newValue,
      previousValue,
      reason: reason ?? null,
    });
  };
}

function reference(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/* ================================================================== *
 * Dashboard metrics
 * ================================================================== */

export type MarketingMetrics = {
  range?: { from: string; to: string };
  leads_total: number;
  leads_new: number;
  leads_overdue: number;
  leads_won: number;
  pipeline_value: number;
  campaigns_running: number;
  campaigns_scheduled: number;
  messages_sent: number;
  messages_delivered: number;
  messages_excluded: number;
  loyalty_members: number;
  points_outstanding: number;
  active_vouchers: number;
  reviews_total: number;
  average_rating: number | null;
  open_recovery_cases: number;
  suppressed_contacts: number;
  marketing_cost: number;
  attributed_revenue: number;
  romi: number | null;
  romi_basis: string;
  error?: string;
};

export function useMarketingMetrics(branchId?: string | null, from?: string, to?: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "metrics", organizationId, branchId ?? null, from ?? null, to ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "marketing_metrics", {
        _branch: branchId ?? null,
        _from: from ?? null,
        _to: to ?? null,
      });
      fail(error);
      return (data ?? {}) as MarketingMetrics;
    },
  });
}

/* ================================================================== *
 * Settings
 * ================================================================== */

export function useMarketingSettings() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "settings", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("marketing_settings")
        .select("*")
        .eq("organization_id", organizationId)
        .maybeSingle();
      fail(error);
      return (data as Row | null) ?? null;
    },
  });
}

export function useSaveMarketingSettings() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (patch: Row) => {
      const { data, error } = await sb
        .from("marketing_settings")
        .upsert(
          { ...patch, organization_id: organizationId, created_by: user?.id ?? null },
          { onConflict: "organization_id" },
        )
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.settings.updated", String(row["id"]), row);
      invalidate();
      toast.success("Marketing settings saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Leads
 * ================================================================== */

export type LeadFilters = {
  stage?: string;
  assignee?: string;
  branchId?: string;
  search?: string;
  overdueOnly?: boolean;
};

export function useLeads(filters: LeadFilters = {}) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "leads", organizationId, filters, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("leads").select("*, lead_sources(name, category), customers(full_name, customer_number)"), "leads")
        .order("created_at", { ascending: false })
        .limit(500);
      if (filters.stage) q = q.eq("stage", filters.stage);
      if (filters.assignee) q = q.eq("assigned_to", filters.assignee);
      if (filters.branchId) q = q.eq("branch_id", filters.branchId);
      if (filters.search) {
        q = q.or(
          ilikeOrFilter(["contact_name", "company", "lead_number", "email"], filters.search),
        );
      }
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useLead(id: string | undefined) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: [KEY, "lead", id, filterKey],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await applyTo(sb.from("leads").select("*, lead_sources(name), customers(id, full_name, email, phone, customer_number)"), "leads")
        .eq("id", id)
        .maybeSingle();
      fail(error);
      return (data as Row | null) ?? null;
    },
  });
}

export function useLeadSources() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "lead-sources", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("lead_sources")
        .select("*")
        .eq("active", true)
        .order("name");
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateLeadSource() {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: { name: string; code: string; category: string }) => {
      const { data, error } = await sb
        .from("lead_sources")
        .insert({ ...input, organization_id: organizationId })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.lead_source.created", String(row["id"]), row);
      invalidate();
      toast.success("Lead source added");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCreateLead() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { data, error } = await sb
        .from("leads")
        .insert({
          ...input,
          organization_id: organizationId,
          lead_number: reference("LD"),
          created_by: user?.id ?? null,
        })
        .select()
        .single();
      fail(error);
      const row = data as Row;
      await sb.from("lead_stage_history").insert({
        organization_id: organizationId,
        lead_id: row["id"],
        from_stage: null,
        to_stage: row["stage"] ?? "new",
        reason: "Lead created",
        changed_by: user?.id ?? null,
      });
      return row;
    },
    onSuccess: async (row) => {
      await audit("marketing.lead.created", String(row["id"]), row);
      invalidate();
      toast.success(`Lead ${String(row["lead_number"])} created`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateLead() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Row }) => {
      const { data, error } = await sb.from("leads").update(patch).eq("id", id).select().single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.lead.updated", String(row["id"]), row);
      invalidate();
      toast.success("Lead updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Stage moves are always recorded in the immutable stage history. */
export function useMoveLeadStage() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({
      id,
      fromStage,
      toStage,
      reason,
    }: {
      id: string;
      fromStage: string;
      toStage: string;
      reason?: string;
    }) => {
      const patch: Row = { stage: toStage };
      if (toStage === "lost") patch["loss_reason"] = reason ?? "Not specified";
      const { data, error } = await sb.from("leads").update(patch).eq("id", id).select().single();
      fail(error);
      await sb.from("lead_stage_history").insert({
        organization_id: organizationId,
        lead_id: id,
        from_stage: fromStage,
        to_stage: toStage,
        reason: reason ?? null,
        changed_by: user?.id ?? null,
      });
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.lead.stage_changed", String(row["id"]), { stage: row["stage"] });
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssignLead() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, assignee }: { id: string; assignee: string | null }) => {
      const { data, error } = await sb
        .from("leads")
        .update({
          assigned_to: assignee,
          assigned_at: assignee ? new Date().toISOString() : null,
          stage: assignee ? "assigned" : "new",
        })
        .eq("id", id)
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.lead.assigned", String(row["id"]), { assigned_to: row["assigned_to"] });
      invalidate();
      toast.success("Lead assignment updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Turns a won enquiry into a real customer record.
 *
 * The shared resolver is used rather than a plain insert, so an enquiry from
 * somebody already on the books links to that existing record instead of
 * creating a second one. Nothing is invented: only the name, phone and email
 * captured on the enquiry are carried over.
 */
export function useConvertLeadToCustomer() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ lead, customerId }: { lead: Row; customerId?: string | null }) => {
      const id = String(lead["id"]);
      const name = String(lead["contact_name"] ?? "").trim();
      const phone = String(lead["phone"] ?? "").trim();
      const email = String(lead["email"] ?? "").trim();
      if (!customerId && !phone && !email) {
        throw new Error(
          "This enquiry has no phone or email, so it cannot be matched to a customer. Add a contact first, or pick an existing customer.",
        );
      }

      let resolved = customerId ?? null;
      if (!resolved) {
        const { data, error } = await guardedRpc(sb, "neo_customer_resolve", {
          _org: organizationId,
          _branch: lead["branch_id"] ?? null,
          _full_name: name,
          _phone: phone,
          _email: email,
          _identifier_type: null,
          _identifier_value: null,
        });
        fail(error);
        resolved = data ? String(data) : null;
      }
      if (!resolved) throw new Error("Could not create or match a customer record");

      const { data: number } = await sb
        .from("customers")
        .select("customer_number")
        .eq("id", resolved)
        .maybeSingle();

      const fromStage = String(lead["stage"] ?? "new");
      const { data: updated, error: upErr } = await sb
        .from("leads")
        .update({
          customer_id: resolved,
          stage: "won",
          conversion_module: "crm",
          // The reference column holds the linked record's id, not its number.
          conversion_reference: resolved,
        })
        .eq("id", id)
        .select()
        .single();
      fail(upErr);

      if (fromStage !== "won") {
        await sb.from("lead_stage_history").insert({
          organization_id: organizationId,
          lead_id: id,
          from_stage: fromStage,
          to_stage: "won",
          reason: "Converted to customer",
          changed_by: user?.id ?? null,
        });
      }
      return { lead: updated as Row, customerId: resolved, customerNumber: number?.["customer_number"] ?? null };
    },
    onSuccess: async (res) => {
      await audit("marketing.lead.converted", String(res.lead["id"]), {
        customer_id: res.customerId,
      });
      invalidate();
      toast.success(
        res.customerNumber
          ? `Linked to customer ${String(res.customerNumber)}`
          : "Linked to customer record",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export function useLeadActivities(leadId: string | undefined) {
  return useQuery({
    queryKey: [KEY, "lead-activities", leadId],
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("lead_activities")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useLeadStageHistory(leadId: string | undefined) {
  return useQuery({
    queryKey: [KEY, "lead-history", leadId],
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("lead_stage_history")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useRecordFollowUp() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row & { lead_id: string }) => {
      const { data, error } = await sb
        .from("lead_activities")
        .insert({ ...input, organization_id: organizationId, performed_by: user?.id ?? null })
        .select()
        .single();
      fail(error);
      if (input["due_at"]) {
        await sb.from("leads").update({ next_followup_at: input["due_at"] }).eq("id", input.lead_id);
      }
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.lead.followup_recorded", String(row["id"]), row);
      invalidate();
      toast.success("Follow-up recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Segments (reuses the Phase 4 customer_segments tables)
 * ================================================================== */

export function useSegments() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "segments", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("customer_segments")
        .select("*")
        .order("created_at", { ascending: false });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useSegmentSnapshots(campaignId?: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "snapshots", organizationId, campaignId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = sb.from("segment_snapshots").select("*").order("created_at", { ascending: false });
      if (campaignId) q = q.eq("campaign_id", campaignId);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

/* ================================================================== *
 * Campaigns
 * ================================================================== */

/** Presents stored campaign channels/schedule under the field names the UI reads. */
function normaliseCampaign(row: Row): Row {
  const channels = row["channels"];
  const channel = Array.isArray(channels) && channels.length > 0 ? String(channels[0]) : (row["channel"] ?? "");
  return { ...row, channel, scheduled_at: row["send_at"] ?? null };
}

export function useCampaigns(status?: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "campaigns", organizationId, status ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("campaigns").select("*, customer_segments!campaigns_segment_id_fkey(name)"), "campaigns")
        .order("created_at", { ascending: false });
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      fail(error);
      return ((data ?? []) as Row[]).map((r: Row) => normaliseCampaign(r)) as Row[];
    },
  });
}

export function useCampaign(id: string | undefined) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: [KEY, "campaign", id, filterKey],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await applyTo(sb.from("campaigns").select("*"), "campaigns").eq("id", id).maybeSingle();
      fail(error);
      return data ? normaliseCampaign(data as Row) : null;
    },
  });
}

export function useCreateCampaign() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { channel, scheduled_at: scheduledAt, ...rest } = input as Record<string, unknown>;
      const { data, error } = await sb
        .from("campaigns")
        .insert({
          ...rest,
          channels: channel ? [String(channel)] : (rest["channels"] ?? []),
          send_at: scheduledAt ?? null,
          organization_id: organizationId,
          campaign_number: reference("CMP"),
          owner_id: user?.id ?? null,
          created_by: user?.id ?? null,
        })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.campaign.created", String(row["id"]), row);
      invalidate();
      toast.success(`Campaign ${String(row["campaign_number"])} created`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateCampaign() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Row }) => {
      const { data, error } = await sb.from("campaigns").update(patch).eq("id", id).select().single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.campaign.updated", String(row["id"]), row);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Status transitions are audited individually so the campaign history is readable. */
export function useCampaignStatus() {
  const { user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, status, reason }: { id: string; status: string; reason?: string }) => {
      const patch: Row = { status };
      if (status === "running") patch["launched_at"] = new Date().toISOString();
      if (status === "approved") {
        patch["approval_status"] = "approved";
        patch["approved_by"] = user?.id ?? null;
        patch["approved_at"] = new Date().toISOString();
      }
      if (status === "pending_approval") patch["approval_status"] = "pending";
      const { data, error } = await sb.from("campaigns").update(patch).eq("id", id).select().single();
      fail(error);
      return { row: data as Row, status, reason };
    },
    onSuccess: async ({ row, status, reason }) => {
      await audit(`marketing.campaign.${status}`, String(row["id"]), { status }, reason);
      invalidate();
      toast.success(`Campaign ${status.replace(/_/g, " ")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCampaignAudience(campaignId: string | undefined) {
  return useQuery({
    queryKey: [KEY, "audience", campaignId],
    enabled: Boolean(campaignId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("campaign_audiences")
        .select("*, customers(full_name, customer_number, email, phone)")
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: false })
        .limit(500);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

/**
 * Freezes the campaign audience. Every candidate is checked server-side through
 * `mkt_can_send` before being marked eligible, so a suppressed or unconsented
 * customer can never be queued even if the segment still contains them.
 */
export function useBuildAudience() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({
      campaignId,
      segmentId,
      channel,
    }: {
      campaignId: string;
      segmentId: string | null;
      channel: string;
    }) => {
      let members: Row[] = [];
      if (segmentId) {
        const { data, error } = await sb
          .from("customer_segment_memberships")
          .select("customer_id")
          .eq("segment_id", segmentId)
          .limit(2000);
        fail(error);
        members = (data ?? []) as Row[];
      } else {
        const { data, error } = await sb
          .from("customers")
          .select("id")
          .eq("account_status", "active")
          .is("merged_into_id", null)
          .limit(2000);
        fail(error);
        members = ((data ?? []) as Row[]).map((r) => ({ customer_id: r["id"] }));
      }

      const rows: Row[] = [];
      let reachable = 0;
      for (const m of members) {
        const customerId = String(m["customer_id"]);
        const { data: verdict } = await guardedRpc(sb, "mkt_can_send", {
          _customer: customerId,
          _channel: channel,
          _marketing: true,
        });
        const v = (verdict ?? {}) as { allowed?: boolean; reason?: string };
        const allowed = Boolean(v.allowed);
        if (allowed) reachable += 1;
        rows.push({
          organization_id: organizationId,
          campaign_id: campaignId,
          customer_id: customerId,
          channel,
          eligible: allowed,
          consent_result: v.reason?.startsWith("no_consent") ? v.reason : allowed ? "granted" : "unknown",
          suppression_result: v.reason?.startsWith("suppressed") ? v.reason : "clear",
          exclusion_reason: allowed ? null : (v.reason ?? "not_eligible"),
          status: allowed ? "pending" : "excluded",
        });
      }

      const { data: snap, error: snapErr } = await sb
        .from("segment_snapshots")
        .insert({
          organization_id: organizationId,
          segment_id: segmentId,
          campaign_id: campaignId,
          member_count: rows.length,
          reachable_count: reachable,
          excluded_count: rows.length - reachable,
          criteria: { channel },
          taken_by: user?.id ?? null,
        })
        .select()
        .single();
      fail(snapErr);

      const snapshotId = (snap as Row)["id"];
      if (rows.length) {
        const { error } = await sb
          .from("campaign_audiences")
          .upsert(
            rows.map((r) => ({ ...r, snapshot_id: snapshotId })),
            { onConflict: "campaign_id,customer_id,channel" },
          );
        fail(error);
      }
      return { total: rows.length, reachable, excluded: rows.length - reachable, campaignId };
    },
    onSuccess: async (res) => {
      await audit("marketing.campaign.audience_snapshot", res.campaignId, res);
      invalidate();
      toast.success(`Audience frozen — ${res.reachable} reachable, ${res.excluded} excluded`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Test sends never award vouchers or points and are excluded from reporting. */
export function useSendTest() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({
      campaignId,
      recipients,
      channel,
      subject,
      body,
    }: {
      campaignId: string;
      recipients: string[];
      channel: string;
      subject: string;
      body: string;
    }) => {
      if (!recipients.length) throw new Error("Add at least one internal test recipient");
      const rows = recipients.map((recipient) => ({
        organization_id: organizationId,
        campaign_id: campaignId,
        channel,
        recipient,
        subject: `[TEST] ${subject}`,
        rendered_body: `*** TEST MESSAGE — no vouchers or points are issued ***\n\n${body}`,
        is_marketing: true,
        is_test: true,
        consent_verified: false,
        status: "queued",
        source_module: "marketing",
        source_record_id: campaignId,
        idempotency_key: `test:${campaignId}:${recipient}:${Date.now()}`,
        created_by: user?.id ?? null,
      }));
      const { error } = await sb.from("communication_queue").insert(rows);
      fail(error);
      await sb.from("campaigns").update({ last_test_at: new Date().toISOString() }).eq("id", campaignId);
      return { campaignId, count: rows.length };
    },
    onSuccess: async (res) => {
      await audit("marketing.campaign.test_send", res.campaignId, res);
      invalidate();
      toast.success(`${res.count} test message(s) queued — provider delivery depends on configuration`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Queues the frozen, eligible audience through the Phase 6 communication queue. */
export function useLaunchCampaign() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({
      campaign,
      subject,
      body,
    }: {
      campaign: Row;
      subject: string;
      body: string;
    }) => {
      const campaignId = String(campaign["id"]);
      const { data, error } = await sb
        .from("campaign_audiences")
        .select("id, customer_id, channel, customers(email, phone)")
        .eq("campaign_id", campaignId)
        .eq("eligible", true)
        .eq("status", "pending");
      fail(error);
      const audience = (data ?? []) as Row[];
      if (!audience.length) throw new Error("No eligible recipients — freeze an audience first");

      // A recipient with no address on the chosen channel cannot be reached.
      // Queueing a blank address would look like a sent message and quietly
      // fail at the provider, so it is held back with its reason instead.
      const addressOf = (a: Row) => {
        const contact = (a["customers"] ?? {}) as Row;
        return String(
          (String(a["channel"]) === "email" ? contact["email"] : contact["phone"]) ?? "",
        ).trim();
      };
      const reachable = audience.filter((a) => addressOf(a).length > 0);
      const unreachable = audience.filter((a) => addressOf(a).length === 0);
      if (!reachable.length) {
        throw new Error(
          "No recipient has a contact address on this channel — add their email or phone first.",
        );
      }

      const queueRows = reachable.map((a) => {
        const channel = String(a["channel"]);
        return {
          organization_id: organizationId,
          campaign_id: campaignId,
          customer_id: a["customer_id"],
          channel,
          recipient: addressOf(a),
          subject,
          rendered_body: body,
          is_marketing: true,
          consent_verified: true,
          status: "queued",
          source_module: "marketing",
          source_record_id: campaignId,
          idempotency_key: `campaign:${campaignId}:${String(a["customer_id"])}:${channel}`,
          created_by: user?.id ?? null,
        };
      });
      const { error: qErr } = await sb
        .from("communication_queue")
        // The queue's uniqueness is per workspace, so a re-launch is only
        // recognised as the same message when the workspace is named too.
        .upsert(queueRows, { onConflict: "organization_id,idempotency_key", ignoreDuplicates: true });
      fail(qErr);

      if (unreachable.length) {
        await sb
          .from("campaign_audiences")
          .update({ status: "excluded", eligible: false, exclusion_reason: "no_contact_address" })
          .in("id", unreachable.map((a) => String(a["id"])));
      }

      await sb
        .from("campaign_audiences")
        .update({ status: "queued" })
        .in("id", reachable.map((a) => String(a["id"])));
      await sb
        .from("campaigns")
        .update({ status: "running", launched_at: new Date().toISOString() })
        .eq("id", campaignId);
      return { campaignId, queued: queueRows.length };
    },
    onSuccess: async (res) => {
      await audit("marketing.campaign.launched", res.campaignId, res);
      invalidate();
      toast.success(`${res.queued} message(s) queued for delivery`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Templates (reuses Phase 6 message_templates)
 * ================================================================== */

export function useMessageTemplates(channel?: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "templates", organizationId, channel ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("message_templates").select("*"), "message_templates").order("name");
      if (channel) q = q.eq("channel", channel);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

/* ================================================================== *
 * Journeys
 * ================================================================== */

export function useJourneys() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "journeys", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(sb.from("marketing_journeys").select("*, marketing_journey_steps(count), marketing_journey_enrollments(count)"), "marketing_journeys")
        .order("created_at", { ascending: false });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useJourneySteps(journeyId: string | undefined) {
  return useQuery({
    queryKey: [KEY, "journey-steps", journeyId],
    enabled: Boolean(journeyId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("marketing_journey_steps")
        .select("*")
        .eq("journey_id", journeyId)
        .order("position");
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateJourney() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { data, error } = await sb
        .from("marketing_journeys")
        .insert({ ...input, organization_id: organizationId, owner_id: user?.id ?? null, created_by: user?.id ?? null })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.journey.created", String(row["id"]), row);
      invalidate();
      toast.success("Journey created as a draft");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAddJourneyStep() {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row & { journey_id: string; position: number }) => {
      const { data, error } = await sb
        .from("marketing_journey_steps")
        .insert({ ...input, organization_id: organizationId })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.journey.step_added", String(row["id"]), row);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteJourneyStep() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sb.from("marketing_journey_steps").delete().eq("id", id);
      fail(error);
      return id;
    },
    onSuccess: async (id) => {
      await audit("marketing.journey.step_removed", id, null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useJourneyStatus() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { data, error } = await sb
        .from("marketing_journeys")
        .update({ status })
        .eq("id", id)
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit(`marketing.journey.${String(row["status"])}`, String(row["id"]), { status: row["status"] });
      invalidate();
      toast.success(`Journey ${String(row["status"])}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Consent & suppression
 * ================================================================== */

export function useConsents(customerId?: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "consents", organizationId, customerId ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("customer_consents").select("*, customers(full_name, customer_number)"), "customer_consents")
        .order("created_at", { ascending: false })
        .limit(500);
      if (customerId) q = q.eq("customer_id", customerId);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useSetConsent() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: {
      customerId: string;
      channel: string;
      purpose: string;
      status: string;
      source: string;
      noticeVersionId?: string | null;
    }) => {
      const now = new Date().toISOString();
      const { data, error } = await sb
        .from("customer_consents")
        .upsert(
          {
            organization_id: organizationId,
            customer_id: input.customerId,
            channel: input.channel,
            purpose: input.purpose,
            status: input.status,
            granted: input.status === "granted",
            consent_type: `${input.purpose}_${input.channel}`,
            consent_source: input.source,
            notice_version_id: input.noticeVersionId ?? null,
            effective_at: now,
            withdrawn_at: input.status === "withdrawn" ? now : null,
            evidence: { recorded_via: input.source, at: now },
            recorded_by: user?.id ?? null,
          },
          { onConflict: "customer_id,channel,purpose" },
        )
        .select()
        .single();
      fail(error);

      // Withdrawal suppresses the channel immediately; the record itself is kept.
      if (input.status === "withdrawn" || input.status === "objected") {
        await sb.from("suppression_entries").insert({
          organization_id: organizationId,
          customer_id: input.customerId,
          channel: input.channel,
          reason: "unsubscribed",
          source: input.source,
          notes: "Consent withdrawn by customer or authorized staff",
          created_by: user?.id ?? null,
        });
      } else if (input.status === "granted") {
        await sb
          .from("suppression_entries")
          .update({ active: false })
          .eq("customer_id", input.customerId)
          .eq("channel", input.channel)
          .eq("reason", "unsubscribed");
      }
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.consent.recorded", String(row["id"]), row);
      invalidate();
      toast.success("Consent recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useConsentNotices() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "notices", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("consent_notice_versions")
        .select("*")
        .order("effective_from", { ascending: false });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateConsentNotice() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: { version: string; title: string; body: string }) => {
      const { data, error } = await sb
        .from("consent_notice_versions")
        .insert({ ...input, organization_id: organizationId, created_by: user?.id ?? null })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.consent_notice.created", String(row["id"]), row);
      invalidate();
      toast.success("Consent notice version published");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSuppressions(activeOnly = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "suppressions", organizationId, activeOnly],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = sb
        .from("suppression_entries")
        .select("*, customers(full_name, customer_number, email, phone)")
        .order("created_at", { ascending: false })
        .limit(500);
      if (activeOnly) q = q.eq("active", true);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useAddSuppression() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { data, error } = await sb
        .from("suppression_entries")
        .insert({ ...input, organization_id: organizationId, created_by: user?.id ?? null })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.suppression.added", String(row["id"]), row);
      invalidate();
      toast.success("Suppression added");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useLiftSuppression() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data, error } = await sb
        .from("suppression_entries")
        .update({ active: false, notes: reason })
        .eq("id", id)
        .select()
        .single();
      fail(error);
      return { row: data as Row, reason };
    },
    onSuccess: async ({ row, reason }) => {
      await audit("marketing.suppression.lifted", String(row["id"]), row, reason);
      invalidate();
      toast.success("Suppression lifted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Tags
 * ================================================================== */

export function useCustomerTags() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "tags", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb.from("customer_tags").select("*").order("name");
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateCustomerTag() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: { name: string; colour: string; description?: string }) => {
      const { data, error } = await sb
        .from("customer_tags")
        .insert({ ...input, organization_id: organizationId, created_by: user?.id ?? null })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.tag.created", String(row["id"]), row);
      invalidate();
      toast.success("Tag created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Promotions & vouchers (reuses Phase 4 / Phase 14 architecture)
 * ================================================================== */

export function usePromotions() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "promotions", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("promotion_codes")
        .select("*")
        .order("created_at", { ascending: false });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useVouchers(status?: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "vouchers", organizationId, status ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("reward_vouchers").select("*, customers(full_name, customer_number)"), "reward_vouchers")
        .order("created_at", { ascending: false })
        .limit(500);
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

/** Voucher codes are generated with cryptographic randomness, never sequential. */
function secureVoucherCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `VC-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

export function useCreateVoucher() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row & { customer_id: string }) => {
      const idem = `voucher:${input.customer_id}:${String(input["reward_source"] ?? "manual")}:${String(input["campaign_id"] ?? "none")}`;
      const { data, error } = await sb
        .from("reward_vouchers")
        .insert({
          ...input,
          organization_id: organizationId,
          code: secureVoucherCode(),
          status: "active",
          idempotency_key: idem,
          created_by: user?.id ?? null,
        })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.voucher.issued", String(row["id"]), row);
      invalidate();
      toast.success(`Voucher ${String(row["code"])} issued`);
    },
    onError: (e: Error) =>
      toast.error(
        e.message.includes("duplicate")
          ? "A voucher already exists for this customer and reward source"
          : e.message,
      ),
  });
}

export function useCancelVoucher() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data, error } = await sb
        .from("reward_vouchers")
        .update({ status: "cancelled" })
        .eq("id", id)
        .select()
        .single();
      fail(error);
      return { row: data as Row, reason };
    },
    onSuccess: async ({ row, reason }) => {
      await audit("marketing.voucher.cancelled", String(row["id"]), row, reason);
      invalidate();
      toast.success("Voucher cancelled");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Referrals
 * ================================================================== */

export function useReferralProgrammes() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "referral-programmes", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("referral_programmes")
        .select("*")
        .order("created_at", { ascending: false });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateReferralProgramme() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { data, error } = await sb
        .from("referral_programmes")
        .insert({ ...input, organization_id: organizationId, created_by: user?.id ?? null })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.referral_programme.created", String(row["id"]), row);
      invalidate();
      toast.success("Referral programme created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReferrals() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "referrals", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("customer_referrals")
        .select(
          "*, referrer:customers!customer_referrals_referrer_customer_id_fkey(full_name, customer_number), referred:customers!customer_referrals_referred_customer_id_fkey(full_name, customer_number)",
        )
        .order("created_at", { ascending: false })
        .limit(300);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useReviewReferral() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, status, reason }: { id: string; status: string; reason?: string }) => {
      const patch: Row = { reward_status: status };
      if (status === "rejected") {
        patch["fraud_flag"] = true;
        patch["fraud_reason"] = reason ?? "Rejected on review";
      }
      if (status === "qualified") patch["qualified_at"] = new Date().toISOString();
      const { data, error } = await sb
        .from("customer_referrals")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      fail(error);
      return { row: data as Row, reason };
    },
    onSuccess: async ({ row, reason }) => {
      await audit(`marketing.referral.${String(row["reward_status"])}`, String(row["id"]), row, reason);
      invalidate();
      toast.success("Referral updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Reputation & service recovery
 * ================================================================== */

export function useReviews(filters: { status?: string; source?: string } = {}) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "reviews", organizationId, filters, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("reviews").select("*, customers(full_name, customer_number), review_responses(id, status, draft_body)"), "reviews")
        .order("review_date", { ascending: false })
        .limit(300);
      if (filters.status) q = q.eq("status", filters.status);
      if (filters.source) q = q.eq("source", filters.source);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateReview() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { data, error } = await sb
        .from("reviews")
        .insert({ ...input, organization_id: organizationId, created_by: user?.id ?? null })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.review.recorded", String(row["id"]), row);
      invalidate();
      toast.success("Review recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateReview() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Row }) => {
      const { data, error } = await sb.from("reviews").update(patch).eq("id", id).select().single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.review.updated", String(row["id"]), row);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSaveReviewResponse() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: { reviewId: string; body: string; aiAssisted: boolean }) => {
      const { data, error } = await sb
        .from("review_responses")
        .insert({
          organization_id: organizationId,
          review_id: input.reviewId,
          draft_body: input.body,
          ai_assisted: input.aiAssisted,
          status: "pending_approval",
          drafted_by: user?.id ?? null,
        })
        .select()
        .single();
      fail(error);
      await sb.from("reviews").update({ status: "pending_approval" }).eq("id", input.reviewId);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.review_response.drafted", String(row["id"]), row);
      invalidate();
      toast.success("Response drafted and sent for approval");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Approval and publication are separate acts — nothing is auto-published. */
export function useReviewResponseAction() {
  const { user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({
      id,
      reviewId,
      action,
      channel,
    }: {
      id: string;
      reviewId: string;
      action: "approved" | "rejected" | "published";
      channel?: string;
    }) => {
      const patch: Row = { status: action };
      if (action === "approved") {
        patch["approved_by"] = user?.id ?? null;
        patch["approved_at"] = new Date().toISOString();
      }
      if (action === "published") {
        patch["published_at"] = new Date().toISOString();
        patch["publish_channel"] = channel ?? "manual";
      }
      const { data, error } = await sb
        .from("review_responses")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      fail(error);
      if (action === "published") {
        await sb.from("reviews").update({ status: "responded" }).eq("id", reviewId);
      }
      if (action === "rejected") {
        await sb.from("reviews").update({ status: "investigating" }).eq("id", reviewId);
      }
      return { row: data as Row, action };
    },
    onSuccess: async ({ row, action }) => {
      await audit(`marketing.review_response.${action}`, String(row["id"]), row);
      invalidate();
      toast.success(`Response ${action}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecoveryCases(openOnly = false) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "recovery", organizationId, openOnly, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("service_recovery_cases").select("*, customers(full_name, customer_number)"), "service_recovery_cases")
        .order("created_at", { ascending: false })
        .limit(300);
      if (openOnly) q = q.not("status", "in", '("resolved","closed")');
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateRecoveryCase() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { data, error } = await sb
        .from("service_recovery_cases")
        .insert({
          ...input,
          organization_id: organizationId,
          case_number: reference("SR"),
          created_by: user?.id ?? null,
        })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.recovery_case.created", String(row["id"]), row);
      invalidate();
      toast.success(`Recovery case ${String(row["case_number"])} opened`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateRecoveryCase() {
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async ({ id, patch, reason }: { id: string; patch: Row; reason?: string }) => {
      const { data, error } = await sb
        .from("service_recovery_cases")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      fail(error);
      return { row: data as Row, reason };
    },
    onSuccess: async ({ row, reason }) => {
      await audit("marketing.recovery_case.updated", String(row["id"]), row, reason);
      invalidate();
      toast.success("Recovery case updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Costs, conversions & attribution
 * ================================================================== */

export function useMarketingCosts(campaignId?: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "costs", organizationId, campaignId ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("marketing_costs").select("*, campaigns(name, campaign_number)"), "marketing_costs")
        .order("incurred_on", { ascending: false });
      if (campaignId) q = q.eq("campaign_id", campaignId);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useAddMarketingCost() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = useMarketingAudit();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { data, error } = await sb
        .from("marketing_costs")
        .insert({ ...input, organization_id: organizationId, created_by: user?.id ?? null })
        .select()
        .single();
      fail(error);
      return data as Row;
    },
    onSuccess: async (row) => {
      await audit("marketing.cost.recorded", String(row["id"]), row);
      invalidate();
      toast.success("Cost recorded — Finance verification still required");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useConversions(campaignId?: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "conversions", organizationId, campaignId ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(sb.from("campaign_conversions").select("*, campaigns(name, campaign_number), customers(full_name)"), "campaign_conversions")
        .order("occurred_at", { ascending: false })
        .limit(300);
      if (campaignId) q = q.eq("campaign_id", campaignId);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useAttributionEvents() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "attribution", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("attribution_events")
        .select("*, campaigns(name)")
        .order("occurred_at", { ascending: false })
        .limit(300);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

/* ================================================================== *
 * Feedback analytics (reads the Phase 4 feedback tables)
 * ================================================================== */

export function useFeedbackAnalytics() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "feedback-analytics", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(sb.from("customer_feedback").select("id, rating, category, feedback_type, status, received_at, first_response_at, resolved_at, branch_id"), "customer_feedback")
        .order("received_at", { ascending: false })
        .limit(1000);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

/* ================================================================== *
 * Customer self-service (own records only)
 * ================================================================== */

export function useMyCustomerRecord() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [KEY, "me", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const { data, error } = await sb
        .from("customers")
        .select("id, organization_id, full_name, preferred_name, customer_number, email, phone, preferred_language")
        .eq("auth_user_id", user!.id)
        .maybeSingle();
      fail(error);
      return (data as Row | null) ?? null;
    },
  });
}

export function useMyEngagement(customerId: string | undefined) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: [KEY, "my-engagement", customerId, filterKey],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const [consents, vouchers, loyalty, referrals, reviews] = await Promise.all([
        applyTo(sb.from("customer_consents").select("*"), "customer_consents").eq("customer_id", customerId),
        applyTo(sb.from("reward_vouchers").select("*"), "reward_vouchers").eq("customer_id", customerId).order("created_at", { ascending: false }),
        sb
          .from("loyalty_accounts")
          .select("*, loyalty_tiers(name), loyalty_programs(name)")
          .eq("customer_id", customerId)
          .maybeSingle(),
        sb.from("customer_referrals").select("*").eq("referrer_customer_id", customerId),
        applyTo(sb.from("reviews").select("*"), "reviews").eq("customer_id", customerId).order("review_date", { ascending: false }),
      ]);
      return {
        consents: (consents.data ?? []) as Row[],
        vouchers: (vouchers.data ?? []) as Row[],
        loyalty: (loyalty.data ?? null) as Row | null,
        referrals: (referrals.data ?? []) as Row[],
        reviews: (reviews.data ?? []) as Row[],
      };
    },
  });
}

/* ================================================================== *
 * Staff directory (lead assignment)
 * ================================================================== */

export function useAssignableStaff() {
  // Canonical profiles.id options for the active property only.
  return useScopedWorkerOptions();
}

export function useCustomersLookup(search: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "customer-lookup", organizationId, search],
    enabled: Boolean(organizationId) && search.length >= 2,
    queryFn: async () => {
      const { data, error } = await sb
        .from("customers")
        .select("id, full_name, customer_number, email, phone")
        .or(ilikeOrFilter(["full_name", "customer_number", "email"], search))
        .limit(20);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

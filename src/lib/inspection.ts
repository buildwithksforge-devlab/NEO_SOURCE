import { guardedRpc } from "@/lib/rpc-guard";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActivePropertyFilter } from "@/lib/branch-filter";

/**
 * Inspection & auditability layer.
 *
 * Two questions this answers for the property currently being viewed:
 *
 * 1. Can every important transaction say who created it, who changed it, who
 *    approved it, when, at which property, what changed and whether the next
 *    step downstream actually happened? `neo_audit_completeness` counts that
 *    per transaction family instead of asserting it.
 * 2. Did meaningful events reach the right person? `neo_notification_integrity`
 *    compares how often an event happened against how many notices were
 *    delivered for it, and separates the two failure modes that matter:
 *    a missing critical alert, and notification spam (over-broad fanout or
 *    duplicate notices to the same reader).
 *
 * Both routines are read-only and organisation-scoped in the database; nothing
 * here can change operational data.
 */

export type AuditCompletenessRow = {
  module: string;
  label: string;
  total: number;
  with_actor: number;
  with_trail: number;
  with_approval: number;
  approval_required: boolean;
  handoff_label: string;
  handoff_ok: number;
  missing_actor: number;
  missing_trail: number;
  missing_handoff: number;
  status: "ready" | "partial" | "attention" | "unknown";
};

export type AuditCompleteness = {
  generated_at: string;
  branch_id: string | null;
  gaps: number;
  transactions: AuditCompletenessRow[];
};

export type NotificationIntegrityRow = {
  event_type: string;
  triggers: number;
  covered: number;
  missing: number;
  notices: number;
  recipients: number;
  fanout_max: number;
  duplicates: number;
  stale_actions: number;
  unprocessed: number;
  rule_configured: boolean;
  status: "ok" | "missing-alerts" | "spam" | "unattended" | "unconfigured" | "unknown";
};

export type NotificationIntegrity = {
  generated_at: string;
  branch_id: string | null;
  window_days: number;
  fanout_limit: number;
  events: NotificationIntegrityRow[];
  escalations_open: number;
  escalations_unacknowledged: number;
  missing: number;
  spam: number;
  unconfigured: number;
};

/** Plain-language explanation of what an inspection row is telling the reader. */
export function auditGapReason(row: AuditCompletenessRow): string | null {
  if (row.total === 0) return null;
  if (row.missing_actor > 0)
    return `${row.missing_actor} record${row.missing_actor === 1 ? "" : "s"} do not record who created them.`;
  if (row.missing_handoff > 0)
    return `${row.missing_handoff} did not complete the next step (${row.handoff_label.toLowerCase()}).`;
  if (row.missing_trail > 0)
    return `${row.missing_trail} have no recorded change history yet.`;
  return null;
}

/** Severity ordering so the worst notification failures surface first. */
const NOTIFICATION_SEVERITY: Record<NotificationIntegrityRow["status"], number> = {
  "missing-alerts": 0,
  spam: 1,
  unattended: 2,
  unconfigured: 3,
  ok: 4,
  unknown: 5,
};

export function sortNotificationRows(rows: NotificationIntegrityRow[]): NotificationIntegrityRow[] {
  return [...rows].sort(
    (a, b) =>
      NOTIFICATION_SEVERITY[a.status] - NOTIFICATION_SEVERITY[b.status] ||
      b.missing - a.missing ||
      a.event_type.localeCompare(b.event_type),
  );
}

export function notificationVerdict(row: NotificationIntegrityRow): string {
  switch (row.status) {
    case "missing-alerts":
      return `${row.missing} occurrence${row.missing === 1 ? "" : "s"} produced no notice — nobody was informed.`;
    case "spam":
      return row.duplicates > 0
        ? `${row.duplicates} duplicate notice${row.duplicates === 1 ? "" : "s"} sent to the same reader.`
        : `Notified ${row.fanout_max} people for a single occurrence — too broad.`;
    case "unattended":
      return `${row.stale_actions} action-required notice${row.stale_actions === 1 ? "" : "s"} unattended for over 24 hours.`;
    case "unconfigured":
      return "No routing rule decides who receives this event.";
    case "unknown":
      return "Awaiting data — this event has not occurred in the window.";
    default:
      return "Every occurrence reached a notified recipient.";
  }
}

export function useAuditCompleteness() {
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["integrity", "audit-completeness", filterKey],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_audit_completeness" as never, {
        _branch: branchId,
      } as never);
      if (error) throw error;
      return data as unknown as AuditCompleteness;
    },
  });
}

export function useNotificationIntegrity(days = 30) {
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["integrity", "notification-integrity", filterKey, days],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_notification_integrity" as never, {
        _branch: branchId,
        _days: days,
      } as never);
      if (error) throw error;
      return data as unknown as NotificationIntegrity;
    },
  });
}

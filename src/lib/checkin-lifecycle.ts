/**
 * The canonical check-in / revert lifecycle.
 *
 * Front-end mirror of `public.pms_check_in`, `public.pms_revert_check_in` and
 * `public.neo_checkin_reconciliation`. It states, in one place, which records a
 * successful arrival must create, which of those a revert must undo, and every
 * reason a revert is refused. `checkin-lifecycle.test.ts` asserts each entry
 * against the deployed SQL, so drift fails the build instead of quietly
 * breaking the in-house count.
 */

/** Records `pms_check_in` writes. Every one of these is part of the in-house picture. */
export const CHECK_IN_EFFECTS = [
  "stays",
  "folios",
  "reservations",
  "rooms",
  "room_assignments",
  "room_status_history",
  "tasks",
  "notifications",
  "customer_timeline_events",
  "pms_workflow_events",
  "audit_logs",
] as const;

/** What a revert must undo, so the reservation looks as it did before arrival. */
export const REVERT_EFFECTS = [
  "folio_lines",
  "folios",
  "stays",
  "reservations",
  "rooms",
  "room_assignments",
  "room_status_history",
  "pms_workflow_events",
  "customer_timeline_events",
  "notifications",
  "audit_logs",
] as const;

export type RevertRefusal = {
  reason: string;
  /** Plain-language explanation shown to staff. */
  meaning: string;
};

/** Every non-exception refusal the RPC returns as `{ ok: false, reason }`. */
export const REVERT_REFUSALS: RevertRefusal[] = [
  { reason: "no_organisation", meaning: "The session has no workspace attached." },
  { reason: "reason_required", meaning: "A written reason is mandatory for the audit trail." },
  { reason: "not_found", meaning: "The reservation does not exist in this workspace." },
  { reason: "not_checked_in", meaning: "There is no open stay to revert." },
  { reason: "already_checked_out", meaning: "Reverse the departure before the arrival." },
  { reason: "folio_has_activity", meaning: "Posted folio lines must be reversed or transferred first." },
];

/** Reconciliation findings surfaced by neo_checkin_reconciliation. */
export const RECONCILIATION_ISSUES = [
  { issue: "checked_in_without_stay", severity: "critical", drill: "/pms/arrivals" },
  { issue: "stay_without_folio", severity: "critical", drill: "/pms/in-house" },
  { issue: "room_not_occupied", severity: "warning", drill: "/pms/rooms" },
  { issue: "occupied_without_stay", severity: "warning", drill: "/pms/rooms" },
  { issue: "timeline_missing", severity: "info", drill: "/crm/guests" },
] as const;

/** Capabilities the revert path accepts (either is sufficient). */
export const REVERT_CAPABILITIES = ["pms.checkin.revert", "pms.checkin.perform"] as const;

/** True when the folio state permits a revert without accounting side effects. */
export function revertAllowed(input: {
  hasStay: boolean;
  checkedOut: boolean;
  liveFolioLines: number;
  reason: string;
}): { allowed: boolean; reason?: string } {
  if (!input.reason.trim()) return { allowed: false, reason: "reason_required" };
  if (!input.hasStay) return { allowed: false, reason: "not_checked_in" };
  if (input.checkedOut) return { allowed: false, reason: "already_checked_out" };
  if (input.liveFolioLines > 0) return { allowed: false, reason: "folio_has_activity" };
  return { allowed: true };
}

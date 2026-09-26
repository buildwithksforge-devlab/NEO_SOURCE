/**
 * Operational notification catalogue — the client mirror of
 * `public.notification_templates`.
 *
 * Every notice a workflow raises is declared here with the inbox category it
 * belongs to and the deep link it opens. Because notices are rows in the
 * database (never client state) they survive a refresh and a fresh sign-in;
 * what this catalogue guarantees is the other half of the contract: the link
 * points at a real, guarded route, so opening a notice always lands on the
 * actionable record and the route guard decides whether the reader may see it.
 */
import { UNIVERSAL_ROUTES, capabilityForPath, capabilityKey } from "@/lib/capabilities";

export type NotificationEvent = {
  event: string;
  category: string;
  /** Inbox view the notice must appear under. */
  view: "action-required" | "approvals" | "tasks" | "operational" | "workflow";
  actionRequired: boolean;
  /** Deep link with template placeholders stripped. */
  linkPath: string | null;
  /** Links into a guest/rider public app rather than a staff route. */
  publicApp?: boolean;
};

export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  { event: "pos.ticket_routed", category: "tasks", view: "tasks", actionRequired: true, linkPath: "/kitchen/queue" },
  { event: "kitchen.item_ready", category: "tasks", view: "tasks", actionRequired: true, linkPath: "/pos/orders" },
  { event: "housekeeping.job_created", category: "tasks", view: "tasks", actionRequired: true, linkPath: "/housekeeping" },
  { event: "housekeeping.awaiting_inspection", category: "approvals", view: "approvals", actionRequired: true, linkPath: "/housekeeping" },
  { event: "housekeeping.inspection_passed", category: "operational-alert", view: "operational", actionRequired: false, linkPath: "/pms/rooms" },
  { event: "housekeeping.inspection_failed", category: "tasks", view: "tasks", actionRequired: true, linkPath: "/housekeeping" },
  { event: "maintenance.fault_reported", category: "tasks", view: "tasks", actionRequired: true, linkPath: "/maintenance" },
  { event: "inventory.stock_shortage", category: "operational-alert", view: "operational", actionRequired: true, linkPath: "/inventory" },
  { event: "procurement.request_raised", category: "approvals", view: "approvals", actionRequired: true, linkPath: "/procurement" },
  { event: "procurement.stock_unavailable", category: "operational-alert", view: "operational", actionRequired: true, linkPath: "/procurement" },
  { event: "procurement.goods_received", category: "workflow", view: "workflow", actionRequired: false, linkPath: "/procurement" },
  { event: "delivery.ready_for_dispatch", category: "tasks", view: "tasks", actionRequired: true, linkPath: "/delivery" },
  { event: "delivery.rider_assigned", category: "tasks", view: "tasks", actionRequired: true, linkPath: "/rider", publicApp: true },
  { event: "workflow.escalation", category: "operational-alert", view: "operational", actionRequired: true, linkPath: null },
  { event: "finance.void_requested", category: "approvals", view: "approvals", actionRequired: true, linkPath: "/approvals" },
];

/** The capability a reader needs before the deep link will open for them. */
export function requiredCapabilityForLink(linkPath: string | null): string | null {
  if (!linkPath) return null;
  if (UNIVERSAL_ROUTES.has(linkPath)) return null;
  const capability = capabilityForPath(linkPath);
  return capability ? capabilityKey(capability) : null;
}

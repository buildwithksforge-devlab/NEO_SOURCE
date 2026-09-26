/**
 * GOV-APP-01 — Maker/checker separation.
 *
 * One platform rule: whoever originates a controlled transaction may not approve
 * that same record, even when their role legitimately holds approval authority.
 * The role keeps both permissions — it is the *record* that is off limits, not
 * the power. The database enforces this with a shared guard; these helpers let
 * the interface say so before somebody clicks.
 */

/** Tables carrying a maker column and a checker column, guarded in the database. */
export const MAKER_CHECKER_TABLES: ReadonlyArray<{
  table: string;
  maker: string;
  checker: string;
  label: string;
}> = [
  { table: "banquet_event_orders", maker: "created_by", checker: "approved_by", label: "Banquet event order" },
  { table: "budgets", maker: "created_by", checker: "approved_by", label: "Budget" },
  { table: "campaigns", maker: "created_by", checker: "approved_by", label: "Campaign" },
  { table: "cash_refund_requests", maker: "requested_by", checker: "approved_by", label: "Cash refund" },
  { table: "checkin_deposit_overrides", maker: "requested_by", checker: "approved_by", label: "Deposit override" },
  { table: "complimentary_register", maker: "requested_by", checker: "approved_by", label: "Complimentary" },
  { table: "corporate_credit_applications", maker: "created_by", checker: "decided_by", label: "Credit application" },
  { table: "corporate_credit_settings", maker: "created_by", checker: "approved_by", label: "Credit limit" },
  { table: "credit_notes", maker: "created_by", checker: "approved_by", label: "Credit note" },
  { table: "employment_history", maker: "requested_by", checker: "approved_by", label: "Employee movement" },
  { table: "employment_offers", maker: "created_by", checker: "approved_by", label: "Employment offer" },
  { table: "event_change_requests", maker: "requested_by", checker: "decided_by", label: "Event change" },
  { table: "event_quotations", maker: "created_by", checker: "approved_by", label: "Event quotation" },
  { table: "expense_claims", maker: "requested_by", checker: "approved_by", label: "Expense claim" },
  { table: "journal_entries", maker: "created_by", checker: "posted_by", label: "Journal" },
  { table: "payroll_periods", maker: "hr_reviewed_by", checker: "posted_by", label: "Payroll period" },
  { table: "purchase_orders", maker: "created_by", checker: "approved_by", label: "Purchase order" },
  { table: "purchase_requests", maker: "requested_by", checker: "approved_by", label: "Purchase request" },
  { table: "stock_adjustments", maker: "requested_by", checker: "approved_by", label: "Stock adjustment" },
  { table: "supplier_invoices", maker: "created_by", checker: "approved_by", label: "Supplier invoice" },
  { table: "supplier_payments", maker: "created_by", checker: "approved_by", label: "Supplier payment" },
];

export type ApprovalEligibility = {
  /** Whether this person may record a decision on this record. */
  allowed: boolean;
  /** Plain sentence for the interface; empty when allowed. */
  reason: string;
};

/**
 * Decide whether a viewer may approve one specific record.
 *
 * `exceptionActive` reflects a deliberate, written workspace exception; it is
 * off unless the organisation has configured one.
 */
export function canApproveRecord(input: {
  viewerId: string | null | undefined;
  creatorId: string | null | undefined;
  hasApprovalPermission: boolean;
  exceptionActive?: boolean;
}): ApprovalEligibility {
  const { viewerId, creatorId, hasApprovalPermission, exceptionActive = false } = input;

  if (!viewerId) return { allowed: false, reason: "Sign in to record a decision." };
  if (!hasApprovalPermission)
    return { allowed: false, reason: "You do not hold approval authority for this workflow." };
  if (creatorId && creatorId === viewerId && !exceptionActive)
    return {
      allowed: false,
      reason:
        "You raised this record, so somebody else must approve it. It stays with an independent approver.",
    };
  return { allowed: true, reason: "" };
}

/** Routing outcomes the workspace can report when it looks for an approver. */
export type RoutingStatus =
  | "ok"
  | "owner_reserved"
  | "delegated"
  | "self_only"
  | "unstaffed"
  | "owner_unstaffed"
  | "unconfigured";

/** True when a request is held because the only eligible approver raised it. */
export function isHeldForIndependentApprover(status: string | null | undefined): boolean {
  return status === "self_only";
}

/** Does this record belong in the viewer's "needs your approval" queue? */
export function belongsInMyApprovalQueue(input: {
  viewerId: string | null | undefined;
  creatorId: string | null | undefined;
  assignedUserId?: string | null;
  assignedRoleId?: string | null;
  viewerRoleIds?: string[];
  status: string;
}): boolean {
  const { viewerId, creatorId, assignedUserId, assignedRoleId, viewerRoleIds = [], status } = input;
  if (status !== "pending_approval") return false;
  if (!viewerId) return false;
  if (creatorId && creatorId === viewerId) return false;
  if (assignedUserId) return assignedUserId === viewerId;
  return Boolean(assignedRoleId && viewerRoleIds.includes(assignedRoleId));
}

import { useCallback, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";

/**
 * Active-property (branch) scoping contract.
 *
 * The global property selector already refuses to offer a property the backend
 * would not allow (see `useBranchScope`). This helper makes every module obey
 * that selection: when one property is selected, every property-owned read
 * narrows to that property, and every new record defaults to it. When
 * "All Properties" is selected — which only an organisation-scoped account can
 * choose — no filter is added and RLS remains the sole authority.
 *
 * This is a narrowing filter on top of RLS, never a replacement for it.
 *
 * Two kinds of property-owned tables exist:
 *
 *  - `BRANCH_SCOPED_TABLES` — the row belongs to exactly one property. A row
 *    without a property is meaningless, so the filter is a strict equality.
 *  - `BRANCH_OR_GLOBAL_TABLES` — the table holds both property-owned rows and
 *    deliberate organisation-wide rows (templates, catalogues, settings
 *    defaults, org-level staff). Selecting a property keeps that property's
 *    rows plus the organisation-wide ones, and hides every other property.
 *
 * Anything that is genuinely organisation master data — the role catalogue,
 * permission catalogue, organisation settings, the chart of accounts, the
 * department and work-area registries used by the scoped selectors — is
 * deliberately absent from both sets and must never be branch-filtered here.
 */
export const BRANCH_SCOPED_TABLES = new Set<string>([
  // ---- Front office / PMS -------------------------------------------------
  "reservations",
  "stays",
  "rooms",
  "room_inspections",
  "folios",
  "folio_lines",
  "guest_requests",
  "group_bookings",
  "group_rooming_list",
  "waitlist_entries",
  "transport_requests",
  "night_audit_runs",
  "night_audit_exceptions",
  "business_days",
  "package_revenue_allocations",
  "package_meal_entitlements",
  "complimentary_register",
  // ---- Housekeeping / linen / laundry ------------------------------------
  "housekeeping_jobs",
  "deep_cleaning_schedules",
  "lost_found_items",
  "linen_items",
  "linen_movements",
  "linen_incidents",
  "laundry_batches",
  "guest_laundry_orders",
  // ---- Maintenance / assets / grounds / security -------------------------
  "maintenance_work_orders",
  "assets",
  "defects",
  "grounds_tasks",
  "landscaping_schedules",
  "security_incidents",
  "security_patrols",
  "security_tasks",
  "security_handovers",
  "security_posts",
  "security_post_assignments",
  "security_visitor_logs",
  // ---- POS / restaurant / kitchen ----------------------------------------
  "pos_orders",
  "pos_payments",
  "pos_shifts",
  "pos_void_requests",
  "pos_refund_requests",
  "restaurant_areas",
  "restaurant_tables",
  "table_reservations",
  "bar_tabs",
  "station_tickets",
  "kitchen_shifts",
  "kitchen_handovers",
  "kitchen_breakages",
  "kitchen_hygiene_checks",
  "kitchen_equipment_issues",
  "kitchen_ingredient_requests",
  "kitchen_alert_log",
  "kitchen_ai_insights",
  "kitchen_reconciliation_runs",
  "ingredient_shortage_alerts",
  "production_batches",
  "preparation_targets",
  "pastry_production_plans",
  "pastry_production_items",
  "pastry_custom_orders",
  "quality_check_records",
  "quality_holds",
  "waste_records",
  "department_consumption",
  "menu_items",
  "menu_item_prices",
  "menu_import_batches",
  "recipes",
  // ---- Inventory / stores -------------------------------------------------
  // `stock_items` is deliberately absent here: the catalogue holds both
  // property-owned items and organisation-wide ones, and the balances live on
  // the store rows. Filtering the catalogue strictly by property hid every
  // shared item and left Stock Levels empty while Live Stock showed balances.
  "stock_locations",

  "stock_movements",
  "stock_adjustments",
  "stock_takes",
  "stock_transfers",
  "internal_requisitions",
  "department_stock_needs",
  "inventory_posting_events",
  // ---- Procurement --------------------------------------------------------
  "purchase_orders",
  "purchase_requests",
  "goods_receipts",
  "supplier_invoices",
  "supplier_payments",
  "supplier_quotations",
  // ---- Finance ------------------------------------------------------------
  "invoices",
  "payments",
  "journal_entries",
  "journal_entry_lines",
  "credit_notes",
  "budgets",
  "cash_drawers",
  "cash_counts",
  "cash_transfers",
  "bank_accounts",
  "expense_claims",
  "mpesa_transactions",
  "etims_submissions",
  "financial_alerts",
  "finance_posting_receipts",
  "accounting_sync_log",
  // ---- Events & banqueting ------------------------------------------------
  "event_bookings",
  "event_enquiries",
  "event_quotations",
  "event_billing_items",
  "event_payments",
  "event_room_blocks",
  "event_staff_assignments",
  "event_banquet_tasks",
  "event_issue_reports",
  "event_department_requirements",
  "event_feedback",
  "banquet_event_orders",
  // ---- Delivery -----------------------------------------------------------
  "delivery_orders",
  "delivery_issues",
  "delivery_batches",
  "delivery_supply_requests",
  "rider_shifts",
  "rider_cash_collections",
  "rider_cash_remittances",
  "carts",
  // ---- HR operational records --------------------------------------------
  "employees",
  "attendance_records",
  "leave_requests",
  "overtime_requests",
  "payroll_input_records",
  "disciplinary_cases",
  "grievance_cases",
  "employment_offers",
  "employee_branch_assignments",
  "hr_kpis",
  // ---- Workflow / operations ---------------------------------------------
  "tasks",
  "ticket_assignments",
  "ticket_clarifications",
  "support_tickets",
  "workflow_runs",
  "workflow_failures",
  "scheduled_actions",
  "escalation_events",
  "guard_violations",
  "domain_events",
  "audit_logs",
  "report_runs",
  "generated_reports",
  "dashboard_alerts",
  "dashboard_exports",
  "risk_alerts",
  "kpi_snapshots",
  "analytics_snapshots",
  "forecasts",
  // ---- Property-specific CRM & marketing ---------------------------------
  "customer_feedback",
  "customer_communications",
  "customer_timeline_events",
  "customer_notes",
  "customer_statements",
  "customer_consents",
  "loyalty_transactions",
  "reward_vouchers",
  "service_recovery_cases",
  "reviews",
  "feedback_invitations",
  "campaign_conversions",
  "marketing_costs",
  "marketing_content_items",
  "leads",
  "communication_queue",
]);

/**
 * Tables that legitimately mix property-owned rows with organisation-wide rows.
 * A selected property keeps its own rows plus the organisation-wide ones.
 */
export const BRANCH_OR_GLOBAL_TABLES = new Set<string>([
  // Directory: org-level staff (owner, group finance, IT) carry no property.
  "profiles",
  "rider_profiles",
  // The stock catalogue: property-owned items plus organisation-wide items.
  "stock_items",
  // Catalogues, templates and per-property configuration with org defaults.

  "room_types",
  "rate_plans",
  "meal_plans",
  "menus",
  "package_allocation_rules",
  "portion_standards",
  "quality_checklists",
  "housekeeping_checklist_templates",
  "preventive_maintenance_plans",
  "laundry_price_items",
  "transport_products",
  "event_venues",
  "event_resources",
  "event_packages",
  "delivery_zones",
  "delivery_settings",
  "pms_settings",
  "pos_settings",
  "kitchen_settings",
  "printer_profiles",
  "station_routing_rules",
  "task_assignment_rules",
  "workflow_definitions",
  "notification_rules",
  "notifications",
  "escalation_policies",
  "message_templates",
  "approval_rules",
  "approval_requests",
  "corporate_accounts",
  // Suppliers are held once for the group, with property-specific suppliers
  // alongside them; a selected property sees both, never another property's.
  "suppliers",
  "campaigns",
  "marketing_journeys",
  "feedback_automation_rules",
  "leave_types",
  "onboarding_templates",
  "ai_recommendations",
]);

/**
 * Child tables that carry no property column of their own. They are always
 * read through their canonical parent, which is the branch-scoped record —
 * duplicating a `branch_id` on them is explicitly not the fix.
 */
export const PARENT_SCOPED_TABLES: Record<string, { parent: string; column: string }> = {
  pos_order_items: { parent: "pos_orders", column: "order_id" },
  purchase_order_lines: { parent: "purchase_orders", column: "purchase_order_id" },
  goods_receipt_lines: { parent: "goods_receipts", column: "goods_receipt_id" },
  folio_allocations: { parent: "folios", column: "folio_id" },
  attendance_breaks: { parent: "attendance_records", column: "attendance_id" },
  delivery_batch_orders: { parent: "delivery_batches", column: "batch_id" },
  cart_items: { parent: "carts", column: "cart_id" },
};

/** True when the table is property-owned under either scoping rule. */
export function isPropertyOwnedTable(table: string): boolean {
  return BRANCH_SCOPED_TABLES.has(table) || BRANCH_OR_GLOBAL_TABLES.has(table);
}

export function useActivePropertyFilter() {
  const { activeBranchId, orgWide } = useBranchScope();

  /** The selected property, or null when the user is viewing all properties. */
  const branchId = useMemo(
    () => (activeBranchId && activeBranchId !== "all" ? activeBranchId : null),
    [activeBranchId],
  );

  // Generic in the builder type so generated Supabase typings survive the
  // filter — the narrowing is invisible to call sites.
  const applyTo = useCallback(
    <T,>(q: T, table: string, column = "branch_id"): T => {
      if (!branchId) return q;
      if (BRANCH_SCOPED_TABLES.has(table)) {
        return (q as { eq: (c: string, v: string) => T }).eq(column, branchId) as T;
      }
      if (BRANCH_OR_GLOBAL_TABLES.has(table)) {
        return (q as { or: (f: string) => T }).or(`${column}.eq.${branchId},${column}.is.null`) as T;
      }
      return q;
    },
    [branchId],
  );

  return { branchId, orgWide, applyTo, filterKey: branchId ?? "all" };
}

/**
 * The property a NEW record belongs to.
 *
 * Reads, filters and writes must agree, so the explicitly selected active
 * property always wins. `profile.branch_id` stays a home/default assignment and
 * is only used when nothing is selected (or "All Properties" is in view) — it
 * must never override an operator who has deliberately switched property.
 */
export function useWriteBranchId(): string | null {
  const { branchId } = useActivePropertyFilter();
  const { profile } = useAuth();
  const home = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return branchId ?? home;
}

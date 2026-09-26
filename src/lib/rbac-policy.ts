/**
 * Capability + scope policy — one declaration, everything derived.
 *
 * The recurring RBAC defect was that routes, sidebar links, buttons and RPC
 * access were each decided somewhere different, so a rider could reach a
 * dispatch board, a housekeeper could open inspection, and a store keeper saw a
 * "Create PO" button the database would refuse. Here a role states *what* it
 * may do (capabilities) and *over which records* (scope). Navigation, guards,
 * controls and API checks are all functions of that one statement.
 *
 * This is a policy model, not an authority grant: the database still decides,
 * through `has_permission()` and RLS. The purpose of stating it here is that
 * the UI cannot offer what the backend will refuse, and the mismatch is
 * testable.
 */

import { ROUTE_CAPABILITIES, capabilityKey, type Capability } from "./capabilities";

/** Which records a capability applies to. */
export type RecordScope =
  | "own" // rows where the actor is the assignee/owner
  | "station" // the actor's station or section
  | "department"
  | "property"
  | "organisation";

export const SCOPE_BREADTH: Record<RecordScope, number> = {
  own: 0,
  station: 1,
  department: 2,
  property: 3,
  organisation: 4,
};

export type Grant = { capability: string; scope: RecordScope };

export type RolePolicy = {
  role: string;
  summary: string;
  grants: readonly Grant[];
  /** Capabilities explicitly withheld even if a template would imply them. */
  withheld: readonly string[];
};

const g = (capability: string, scope: RecordScope): Grant => ({ capability, scope });

export const ROLE_POLICIES: Record<string, RolePolicy> = {
  rider: {
    role: "Delivery Rider",
    summary: "Own availability, own assigned deliveries, proof of delivery.",
    grants: [
      g("delivery.availability.edit", "own"),
      g("delivery.assignments.view", "own"),
      g("delivery.assignments.edit", "own"),
      g("delivery.proof.create", "own"),
    ],
    withheld: ["delivery.dispatch.view", "delivery.dispatch.assign", "delivery.orders.edit", "delivery.settings.manage"],
  },
  maintenance_officer: {
    role: "Maintenance Officer",
    summary: "Own assigned jobs only.",
    grants: [
      g("maintenance.workorders.view", "own"),
      g("maintenance.workorders.edit", "own"),
      g("maintenance.requests.create", "property"),
    ],
    withheld: ["maintenance.workorders.assign", "maintenance.workorders.inspect", "maintenance.settings.manage"],
  },
  housekeeper: {
    role: "Housekeeper",
    summary: "Own assigned rooms; no inspection.",
    grants: [
      g("housekeeping.assignments.view", "own"),
      g("housekeeping.assignments.edit", "own"),
      g("housekeeping.lostfound.create", "property"),
    ],
    withheld: ["housekeeping.inspection.perform", "housekeeping.assignments.assign", "housekeeping.settings.manage"],
  },
  store_keeper: {
    role: "Store Keeper",
    summary: "Receive, issue, accept returns and view stock. No purchase orders.",
    grants: [
      g("stores.receipts.create", "property"),
      g("stores.issues.create", "property"),
      g("stores.returns.accept", "property"),
      g("stores.stock.view", "property"),
      g("procurement.orders.view", "property"),
    ],
    withheld: [
      "procurement.orders.create",
      "procurement.orders.approve",
      "finance.ap.create",
      "finance.payment.approve",
    ],
  },
  procurement_manager: {
    role: "Procurement Manager",
    summary: "Requisition, purchase order and supplier authority. Payables read-only.",
    grants: [
      g("procurement.requisitions.approve", "organisation"),
      g("procurement.orders.create", "organisation"),
      g("procurement.orders.approve", "organisation"),
      g("procurement.suppliers.manage", "organisation"),
      g("finance.ap.view", "organisation"),
    ],
    withheld: ["finance.ap.create", "finance.payment.approve", "finance.journals.post", "finance.period.close"],
  },
  accountant: {
    role: "Accountant",
    summary: "Capture and match supplier invoices, prepare journals, reconcile.",
    grants: [
      g("finance.dashboard.view", "organisation"),
      g("finance.ap.view", "organisation"),
      g("finance.ap.create", "organisation"),
      g("finance.ap.edit", "organisation"),
      g("finance.journals.view", "organisation"),
      g("finance.journals.create", "organisation"),
      g("finance.reconcile.view", "organisation"),
      g("finance.reconcile.perform", "organisation"),
      g("finance.coa.view", "organisation"),
    ],
    withheld: [
      "finance.payment.approve",
      "finance.period.close",
      "finance.coa.manage",
      "finance.journals.post",
    ],
  },
  finance_manager: {
    role: "Finance Manager",
    summary: "Posting, review, scheduling and release within policy.",
    grants: [
      g("finance.dashboard.view", "organisation"),
      g("finance.journals.view", "organisation"),
      g("finance.journals.create", "organisation"),
      g("finance.journals.post", "organisation"),
      g("finance.ap.view", "organisation"),
      g("finance.ap.create", "organisation"),
      g("finance.payment.approve", "organisation"),
      g("finance.reconcile.perform", "organisation"),
      g("finance.period.view", "organisation"),
      g("finance.period.close", "organisation"),
      g("finance.coa.view", "organisation"),
      g("finance.coa.manage", "organisation"),
    ],
    withheld: ["platform.settings.manage", "hr.payroll.approve"],
  },
  operations_manager: {
    role: "Operations Manager",
    summary: "Property-wide operational command and approvals within policy. No finance posting, no system configuration.",
    grants: [
      g("front-office.overview.view", "property"),
      g("housekeeping.overview.view", "property"),
      g("maintenance.workorders.view", "property"),
      g("maintenance.workorders.assign", "property"),
      g("restaurant.orders.view", "property"),
      g("approvals.inbox.view", "property"),
      g("approvals.inbox.decide", "property"),
      g("reports.operations.view", "property"),
    ],
    withheld: [
      "finance.journals.post",
      "finance.payment.approve",
      "finance.period.close",
      "platform.settings.manage",
    ],
  },
  owner: {
    role: "Owner / Director",
    summary: "Top authority and system governance.",
    grants: [g("*", "organisation")],
    withheld: [],
  },
};

/** Discount ceiling by role, as a percentage. Policy, enforced server-side. */
export const DISCOUNT_CEILING: Record<string, number> = {
  operations_manager: 15,
  finance_manager: 15,
  owner: 100,
};

export type PolicyDecision =
  | { allowed: true; scope: RecordScope }
  | { allowed: false; reason: "withheld" | "not-granted" | "scope-too-narrow" };

/** Does this role hold `capability` over `required` scope? */
export function decide(
  roleKey: string,
  capability: string,
  required: RecordScope = "own",
): PolicyDecision {
  const policy = ROLE_POLICIES[roleKey];
  if (!policy) return { allowed: false, reason: "not-granted" };
  if (policy.withheld.includes(capability)) return { allowed: false, reason: "withheld" };
  const wildcard = policy.grants.find((x) => x.capability === "*");
  const exact = policy.grants.find((x) => x.capability === capability);
  const grant = exact ?? wildcard;
  if (!grant) return { allowed: false, reason: "not-granted" };
  if (SCOPE_BREADTH[grant.scope] < SCOPE_BREADTH[required])
    return { allowed: false, reason: "scope-too-narrow" };
  return { allowed: true, scope: grant.scope };
}

export const can = (roleKey: string, capability: string, required: RecordScope = "own") =>
  decide(roleKey, capability, required).allowed;

/** Route access derived from the same policy the buttons read. */
export function canOpenRoute(roleKey: string, route: string): boolean {
  const match = [...ROUTE_CAPABILITIES]
    .filter((e) => route === e.prefix || route.startsWith(`${e.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!match) return true; // universal / unregistered pages stay open
  const cap: Capability = { module: match.module, feature: match.feature, action: match.action ?? "view" };
  return can(roleKey, capabilityKey(cap), "own");
}

/** Every capability a role may exercise, for the access matrix. */
export function grantsFor(roleKey: string): readonly Grant[] {
  return ROLE_POLICIES[roleKey]?.grants ?? [];
}

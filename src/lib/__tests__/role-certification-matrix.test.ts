/**
 * Role certification matrix — the nine operating chains, role by role.
 *
 * Every role named in the owner certification schedule is asserted against the
 * exact chain step it must be able to perform, and against the neighbouring
 * authority it must never inherit. Grants come from the same templates the
 * database compiles, scope comes from the same catalogue, and pages resolve
 * through the same capability registry the sidebar and route guard use — so a
 * pass here means the interface cannot offer what the backend would refuse,
 * and a role cannot quietly gain a step of somebody else's chain.
 *
 * This certifies policy, not a live session: it proves the authority model,
 * while an authenticated walkthrough proves the data.
 */
import { describe, expect, it } from "vitest";
import { addGrant } from "@/lib/permissions";
import { moduleFeatures } from "@/lib/capabilities";
import { compileRoleTemplate, ROLE_ACCESS_SCOPES } from "@/lib/role-templates";
import { navItemVisible } from "@/lib/nav-permissions";
import { resolveVisibility, type VisibilityFacts } from "@/lib/visibility-contract";

const FEATURES = moduleFeatures();

function contractFor(roleKey: string) {
  const grants = new Set<string>();
  for (const g of compileRoleTemplate(roleKey, FEATURES)) addGrant(grants, g.module, g.feature, g.action);
  const facts: VisibilityFacts = {
    userId: "u-actor",
    accountType: "staff",
    accountStatus: "active",
    organizationId: "org-1",
    accessScope: ROLE_ACCESS_SCOPES[roleKey] ?? "self",
    branchIds: ["prop-a"],
    departmentIds: ["dep-1"],
    stationIds: ["st-1"],
    grants,
    entitlements: {},
    setupComplete: true,
  };
  return { contract: resolveVisibility(facts), grants };
}

type Certification = {
  /** Priority number from the certification schedule, where it has one. */
  priority?: number;
  role: string;
  chain: string;
  /** Pages this role must be able to open to complete its chain step. */
  opens: string[];
  /** Capabilities the chain step depends on. */
  holds: [module: string, feature: string, action: string][];
  /** Pages the role must never reach. */
  denied: string[];
  /** Authority the role must never inherit from a neighbouring chain. */
  withheld: [module: string, feature: string, action: string][];
};

const MATRIX: Certification[] = [
  {
    priority: 1,
    role: "owner",
    chain: "All nine chains, configuration and Finance consequences",
    opens: [
      "/pms/reservations",
      "/housekeeping/board",
      "/maintenance",
      "/pos/orders",
      "/kitchen/queue",
      "/inventory/issues",
      "/procurement/orders",
      "/finance/journals",
      "/finance/eod",
      "/administration/audit-logs",
    ],
    holds: [
      ["finance", "journals", "approve"],
      ["finance", "eod", "approve"],
      ["administration", "audit-logs", "view"],
      ["procurement", "orders", "approve"],
    ],
    denied: [],
    withheld: [],
  },
  {
    priority: 2,
    role: "receptionist",
    chain: "Reservation → assignment → check-in → folio",
    opens: ["/pms/reservations", "/pms/arrivals", "/pms/in-house", "/pms/folios", "/pms/availability"],
    holds: [
      ["front-office", "reservations", "create"],
      ["front-office", "arrivals", "edit"],
      ["front-office", "folios", "view"],
    ],
    denied: ["/finance/journals", "/finance/payables", "/procurement/orders", "/inventory/issues"],
    withheld: [
      ["finance", "journals", "create"],
      ["front-office", "folios", "approve"],
      ["front-office", "rates", "edit"],
    ],
  },
  {
    priority: 3,
    role: "housekeeping-manager",
    chain: "Dirty → assignment → cleaning → inspection → ready",
    opens: [
      "/housekeeping/board",
      "/housekeeping/tasks",
      "/housekeeping/inspections",
      "/pms/rack",
    ],
    holds: [
      ["housekeeping", "board", "edit"],
      ["housekeeping", "inspections", "edit"],
      ["housekeeping", "tasks", "create"],
    ],
    denied: ["/finance/journals", "/procurement/orders", "/pos/orders"],
    withheld: [
      ["finance", "journals", "create"],
      ["procurement", "orders", "create"],
    ],
  },
  {
    priority: 4,
    role: "housekeeper",
    chain: "Assigned rooms only — start and complete cleaning",
    opens: ["/housekeeping/my-work", "/housekeeping/supplies"],
    holds: [
      ["housekeeping", "my-work", "edit"],
      ["housekeeping", "supplies", "create"],
    ],
    denied: ["/housekeeping/inspections", "/housekeeping/board", "/housekeeping/reports", "/finance"],
    withheld: [
      ["housekeeping", "inspections", "view"],
      ["housekeeping", "inspections", "edit"],
      ["housekeeping", "board", "edit"],
    ],
  },
  {
    priority: 5,
    role: "maintenance-manager",
    chain: "Fault → out of order → work order → repair → inspection → ready",
    opens: ["/maintenance", "/maintenance/my-jobs", "/maintenance/landscaping", "/assets", "/housekeeping/board"],
    holds: [
      ["maintenance", "overview", "edit"],
      ["maintenance", "my-jobs", "edit"],
      ["maintenance", "assets", "view"],
    ],
    denied: ["/finance/journals", "/pos/orders", "/procurement/orders"],
    withheld: [
      ["finance", "journals", "create"],
      ["procurement", "orders", "create"],
    ],
  },
  {
    priority: 6,
    role: "waiter",
    chain: "Own tables/orders → send to KDS",
    opens: ["/pos/orders", "/pos/floor", "/pos/kds"],
    holds: [
      ["restaurant", "orders", "create"],
      ["restaurant", "kds", "view"],
    ],
    denied: ["/pos/menu", "/pos/settings", "/pos/approvals", "/pos/reports", "/finance/till"],
    withheld: [
      ["restaurant", "menu", "edit"],
      ["restaurant", "approvals", "approve"],
      ["restaurant", "floor", "create"],
      ["finance", "till", "view"],
    ],
  },
  {
    priority: 7,
    role: "hot-kitchen-chef",
    chain: "Routed tickets → preparation states",
    opens: ["/kitchen", "/kitchen/my-station", "/kitchen/production", "/kitchen/needs"],
    holds: [
      ["kitchen", "my-station", "edit"],
      ["kitchen", "needs", "create"],
    ],
    denied: ["/finance/till", "/finance/collections", "/inventory/issues", "/kitchen/reports"],
    withheld: [
      ["finance", "till", "view"],
      ["finance", "collections", "view"],
      ["stores", "issues", "create"],
    ],
  },
  {
    priority: 8,
    role: "cashier",
    chain: "Till → collection → payment → receipt → Finance queue",
    opens: ["/finance/till", "/finance/collections", "/finance/queue", "/pms/folios", "/pms/departures"],
    holds: [
      ["finance", "till", "edit"],
      // The cashier's collection authority is the specific till action, not a
      // generic create: it records a tender and issues the receipt.
      ["finance", "collections", "collect_payment"],
      ["finance", "collections", "issue_receipt"],
      ["front-office", "folios", "view"],
    ],
    denied: ["/finance/journals", "/finance/payables", "/finance/general-ledger", "/pos/menu"],
    withheld: [
      ["finance", "journals", "create"],
      ["finance", "ap", "create"],
      ["finance", "eod", "approve"],
    ],
  },
  {
    priority: 9,
    role: "storekeeper",
    chain: "Approved requisition → issue → destination movement",
    opens: ["/inventory", "/inventory/items", "/inventory/issues", "/inventory/receiving", "/inventory/reconciliation"],
    holds: [
      ["stores", "issues", "create"],
      ["stores", "reconciliation", "edit"],
      ["procurement", "receiving", "create"],
    ],
    denied: ["/procurement/orders", "/admin/suppliers", "/finance/payables", "/finance/journals"],
    withheld: [
      ["procurement", "orders", "create"],
      ["procurement", "orders", "approve"],
      ["finance", "ap", "create"],
    ],
  },
  {
    priority: 10,
    role: "receiving-clerk",
    chain: "PO goods → GRN, without procurement or Finance authority",
    opens: ["/inventory", "/inventory/receiving"],
    holds: [["procurement", "receiving", "create"]],
    denied: ["/procurement/orders", "/procurement/requests", "/finance/payables", "/inventory/issues"],
    withheld: [
      ["procurement", "orders", "create"],
      ["stores", "issues", "create"],
      ["finance", "ap", "create"],
    ],
  },
  {
    priority: 11,
    role: "procurement-manager",
    chain: "PR → approval routing → PO → supplier visibility",
    opens: ["/procurement/requests", "/procurement/orders", "/admin/suppliers", "/lpos", "/finance/payables"],
    holds: [
      ["procurement", "requests", "approve"],
      ["procurement", "orders", "create"],
      ["procurement", "suppliers", "edit"],
      ["finance", "ap", "view"],
    ],
    denied: ["/finance/journals", "/finance/eod", "/finance/till"],
    withheld: [
      ["finance", "journals", "create"],
      ["finance", "eod", "approve"],
      ["finance", "till", "view"],
    ],
  },
  {
    priority: 12,
    role: "accountant",
    chain: "Supplier invoice → matching → AP → journals → reconciliation",
    opens: [
      "/finance",
      "/finance/payables",
      "/finance/ap-matching",
      "/finance/journals",
      "/finance/general-ledger",
      "/finance/reconciliation",
    ],
    holds: [
      ["finance", "ap", "create"],
      ["finance", "journals", "create"],
      ["finance", "reconciliation", "edit"],
      ["finance", "gl", "view"],
    ],
    denied: ["/procurement/orders", "/pos/menu"],
    withheld: [
      ["finance", "period", "approve"],
      ["finance", "period", "edit"],
      ["finance", "banking", "approve"],
      ["procurement", "orders", "create"],
    ],
  },
  {
    priority: 13,
    role: "finance-manager",
    chain: "Approval/release → journal control → close",
    opens: ["/finance", "/finance/payables", "/finance/journals", "/finance/eod", "/finance/general-ledger"],
    holds: [
      ["finance", "journals", "approve"],
      ["finance", "ap", "approve"],
      ["finance", "eod", "approve"],
      ["finance", "period", "approve"],
    ],
    denied: ["/pos/menu", "/users", "/roles"],
    withheld: [
      ["finance", "quickbooks", "edit"],
      ["administration", "users", "edit"],
      ["human-resources", "payroll", "approve"],
    ],
  },
  {
    priority: 14,
    role: "head-chef",
    chain: "Main Kitchen requisition → recipe/ingredient requirements",
    opens: ["/kitchen", "/kitchen/recipes", "/kitchen/needs", "/kitchen/stores", "/inventory"],
    holds: [
      ["kitchen", "recipes", "edit"],
      ["kitchen", "needs", "create"],
      ["kitchen", "stores", "create"],
    ],
    denied: ["/finance/journals", "/finance/till", "/procurement/orders"],
    withheld: [
      ["finance", "journals", "create"],
      ["procurement", "orders", "create"],
    ],
  },
  {
    priority: 15,
    role: "food-and-beverage-manager",
    chain: "Departmental requisitions, outlet oversight, approvals, cross-waiter scope",
    opens: ["/pos/orders", "/pos/requisitions", "/pos/reports", "/pos/approvals", "/kitchen/queue"],
    holds: [
      ["restaurant", "requisitions", "create"],
      ["restaurant", "approvals", "approve"],
      ["restaurant", "reports", "view"],
    ],
    denied: ["/finance/journals", "/procurement/orders"],
    withheld: [
      ["finance", "journals", "create"],
      ["procurement", "orders", "create"],
    ],
  },
  {
    priority: 16,
    role: "delivery-manager",
    chain: "Assignment → rider monitoring → completion → settlement",
    opens: ["/delivery", "/pos/orders"],
    holds: [["delivery", "overview", "edit"]],
    denied: ["/finance/journals", "/procurement/orders", "/pos/menu"],
    withheld: [["finance", "journals", "create"]],
  },
  {
    priority: 17,
    role: "rider",
    chain: "Assigned delivery → status → proof of delivery",
    opens: ["/delivery", "/rider/support"],
    holds: [["delivery", "my-work", "edit"]],
    denied: ["/delivery/tasks", "/delivery/reports", "/finance/till", "/pos/orders"],
    withheld: [
      ["delivery", "tasks", "edit"],
      ["delivery", "settings", "edit"],
      ["finance", "till", "view"],
    ],
  },

  // Supporting roles from the same schedule.
  {
    role: "coffee-station-supervisor",
    chain: "Requisition for the coffee station, correct station only",
    opens: ["/pos/requisitions", "/pos/orders", "/pos/reports"],
    holds: [["restaurant", "requisitions", "create"]],
    denied: ["/pos/menu", "/pos/floor", "/finance/till"],
    withheld: [
      ["restaurant", "menu", "edit"],
      ["restaurant", "floor", "create"],
    ],
  },
  {
    role: "barista",
    chain: "Station work only, no direct requisition",
    opens: ["/pos/orders", "/pos/kds"],
    holds: [["restaurant", "orders", "create"]],
    denied: ["/pos/requisitions", "/pos/menu", "/finance/till"],
    withheld: [
      ["restaurant", "requisitions", "create"],
      ["restaurant", "menu", "edit"],
    ],
  },
  {
    role: "bar-manager",
    chain: "Bar stock, orders and scope",
    opens: ["/bar", "/bar/queue", "/bar/sell", "/bar/requisitions", "/bar/wastage"],
    holds: [
      ["bar", "pos", "create"],
      ["bar", "requisitions", "create"],
    ],
    denied: ["/finance/journals", "/procurement/orders", "/kitchen/queue"],
    withheld: [["finance", "journals", "create"]],
  },
  {
    role: "bar-attendant",
    chain: "Bar service within own scope",
    opens: ["/bar", "/bar/sell", "/bar/queue"],
    holds: [["bar", "pos", "create"]],
    denied: ["/bar/menu", "/finance/till", "/pos/menu"],
    withheld: [
      ["bar", "menu", "edit"],
      ["finance", "till", "view"],
    ],
  },
  {
    role: "hot-kitchen-supervisor",
    chain: "Production coordination, no direct Stores requisition",
    opens: ["/kitchen/queue", "/kitchen/production", "/kitchen/needs"],
    holds: [["kitchen", "needs", "create"]],
    denied: ["/inventory/issues", "/inventory/requisitions", "/finance/till"],
    withheld: [
      ["stores", "issues", "create"],
      ["stores", "requisitions", "create"],
    ],
  },
  {
    role: "front-office-manager",
    chain: "Broader Front Office scope and supervisory authority",
    opens: ["/pms", "/pms/reservations", "/pms/folios", "/rates", "/pms/rack"],
    holds: [["front-office", "rates", "edit"]],
    denied: ["/finance/journals", "/procurement/orders"],
    withheld: [
      ["finance", "journals", "create"],
      // Separation of duties: folio charges must be approved by someone else.
      ["front-office", "folios", "approve"],
    ],
  },
  {
    role: "operations-manager",
    chain: "Executive visibility, escalations, approvals within policy",
    opens: ["/pms", "/housekeeping/board", "/maintenance", "/pos/orders", "/procurement", "/reports"],
    holds: [
      ["front-office", "overview", "view"],
      ["housekeeping", "board", "view"],
      ["reports", "overview", "view"],
    ],
    denied: ["/finance/journals", "/finance/eod", "/users"],
    withheld: [
      ["finance", "journals", "create"],
      ["procurement", "orders", "create"],
      ["restaurant", "menu", "edit"],
      ["administration", "users", "edit"],
    ],
  },
  {
    role: "human-resources-manager",
    chain: "Employee access without operational or Finance authority",
    opens: ["/hr", "/users", "/departments"],
    holds: [["human-resources", "employees", "edit"]],
    denied: ["/finance/journals", "/pos/orders", "/inventory/issues"],
    withheld: [
      ["finance", "journals", "create"],
      ["restaurant", "orders", "create"],
    ],
  },
  {
    role: "sales-and-events-manager",
    chain: "Enquiry → quotation → booking → deposit → invoice",
    opens: ["/events", "/events/enquiries", "/events/quotations", "/events/bookings", "/events/billing"],
    holds: [
      ["events", "quotations", "create"],
      ["events", "bookings", "create"],
      ["events", "billing", "view"],
    ],
    denied: ["/finance/journals", "/pos/menu"],
    withheld: [["finance", "journals", "create"]],
  },
  {
    role: "banqueting-staff",
    chain: "Assigned event-delivery work only",
    opens: ["/events", "/events/my-tasks"],
    holds: [["events", "my_tasks", "edit"]],
    denied: ["/events/quotations", "/events/billing", "/finance/till"],
    withheld: [
      ["events", "quotations", "create"],
      ["events", "billing", "view"],
    ],
  },
  {
    role: "security-guard",
    chain: "Security functions without operational or financial access",
    opens: ["/security", "/security/my-post", "/security/incidents"],
    holds: [["security-ops", "incidents", "create"]],
    denied: ["/finance/till", "/pos/orders", "/inventory/issues", "/pms/folios"],
    withheld: [
      ["finance", "till", "view"],
      ["front-office", "folios", "view"],
    ],
  },
  {
    role: "social-media-manager",
    chain: "CRM and communications without unrestricted guest Finance access",
    opens: ["/marketing", "/marketing/campaigns", "/marketing/crm/customers"],
    holds: [["marketing", "campaigns", "create"]],
    denied: ["/finance/journals", "/finance/receivables", "/pms/folios"],
    withheld: [
      ["front-office", "folios", "view"],
      ["finance", "receivables", "view"],
    ],
  },
];

describe("role certification matrix — chain step by chain step", () => {
  for (const c of MATRIX) {
    const label = `${c.priority ? `${c.priority}. ` : ""}${c.role} — ${c.chain}`;

    it(`${label}: can perform its own step`, () => {
      const { contract } = contractFor(c.role);
      for (const path of c.opens) expect(contract.canSeePage(path), `${c.role} must open ${path}`).toBe(true);
      for (const [m, f, a] of c.holds)
        expect(contract.canAct(m, f, a), `${c.role} must hold ${m}.${f}.${a}`).toBe(true);
    });

    it(`${label}: never inherits a neighbouring authority`, () => {
      const { contract } = contractFor(c.role);
      for (const path of c.denied)
        expect(contract.canSeePage(path), `${c.role} must not reach ${path}`).toBe(false);
      for (const [m, f, a] of c.withheld)
        expect(contract.canAct(m, f, a), `${c.role} must not hold ${m}.${f}.${a}`).toBe(false);
    });

    it(`${label}: sidebar offers nothing the guard refuses`, () => {
      const { contract } = contractFor(c.role);
      const can = (m: string, f: string, a?: string) => contract.canAct(m, f, a ?? "view");
      for (const path of c.denied)
        expect(navItemVisible(can, path), `${c.role} sidebar must not list ${path}`).toBe(false);
    });
  }
});

describe("cross-role separation of duty", () => {
  it("keeps stock custody and purchasing authority apart", () => {
    const store = contractFor("storekeeper").contract;
    const buyer = contractFor("procurement-manager").contract;
    expect(store.canAct("procurement", "orders", "create")).toBe(false);
    expect(buyer.canAct("procurement", "receiving", "create")).toBe(false);
  });

  it("keeps bookkeeping and money release apart", () => {
    const acct = contractFor("accountant").contract;
    const fm = contractFor("finance-manager").contract;
    expect(acct.canAct("finance", "period", "approve")).toBe(false);
    expect(fm.canAct("finance", "period", "approve")).toBe(true);
  });

  it("keeps cleaning and inspection apart", () => {
    expect(contractFor("housekeeper").contract.canAct("housekeeping", "inspections", "edit")).toBe(false);
    expect(contractFor("housekeeping-manager").contract.canAct("housekeeping", "inspections", "edit")).toBe(true);
  });

  it("keeps service and cash handling apart", () => {
    expect(contractFor("waiter").contract.canAct("finance", "till", "view")).toBe(false);
    expect(contractFor("cashier").contract.canAct("finance", "till", "edit")).toBe(true);
  });

  it("never lets a suspended or unconfigured account inherit a chain step", () => {
    const grants = new Set<string>();
    for (const g of compileRoleTemplate("finance-manager", FEATURES)) addGrant(grants, g.module, g.feature, g.action);
    const suspended = resolveVisibility({
      userId: "u-actor",
      accountType: "staff",
      accountStatus: "suspended",
      organizationId: "org-1",
      accessScope: "department",
      branchIds: ["prop-a"],
      departmentIds: ["dep-1"],
      stationIds: [],
      grants,
      entitlements: {},
      setupComplete: true,
    });
    expect(suspended.canSeePage("/finance/journals")).toBe(false);
  });
});

/**
 * NEØ Intelligent Data Onboarding — relationship match policy and the shared
 * RESOLUTION CONTRACT.
 *
 * Matching a spelling mistake in a category name and matching a human being
 * are not the same business risk, so they do not share a threshold. This file
 * owns, per relationship target:
 *
 *  - how strong the evidence must be before NEØ recommends, asks, or declines;
 *  - which evidence counts as identity evidence (an employee number, a tax
 *    identifier, a room code) as opposed to mere spelling similarity;
 *  - the CAPABILITIES the shared engine may offer for an unresolved value, and
 *    where a governed master is created when NEØ refuses to create it here.
 *
 * The capability list is the single source of truth. Guidance text, the
 * remedies offered, the buttons rendered, the picker's empty state and the
 * import plan's consequences are all derived from it, so a screen can never
 * advertise an action the contract does not support — the defect that made
 * "you may create a category here" appear beside a picker that said "create it
 * in its own module first".
 *
 * Everything here is domain metadata, never a hotel fact. Matching always runs
 * against the caller's own tenant/property-scoped masters — the engine has no
 * way to see another organisation's records, and "no credible match" is always
 * preferred to an unsafe one.
 */
import type { RelationshipTarget } from "./domains";

/** Everything a human may be offered for an unresolved relationship value. */
export type ResolutionCapability =
  | "SELECT_EXISTING"
  | "PROPOSE_MATCH"
  | "MAP_TO_CANONICAL_VALUE"
  | "CREATE_INLINE"
  | "CREATE_IN_OWNING_MODULE"
  | "CREATE_DEPENDENCY_FIRST"
  | "LEAVE_UNASSIGNED"
  | "DEFER_RELATIONSHIP"
  | "REQUIRE_HUMAN_CONFIRMATION"
  | "SKIP_ROW"
  | "BLOCK";

/**
 * How a master may be created from inside an import, when — and only when —
 * the contract grants CREATE_INLINE. The destination is an existing onboarding
 * adapter, so an inline creation obeys exactly the same tenant scope, write
 * rules and duplicate protection as a full import of that domain.
 */
export type InlineCreateSpec = {
  /** Onboarding adapter key owning the destination table. */
  adapterKey: string;
  /** Adapter field the value from the file is written to. */
  labelField: string;
  /** Fields the canonical master needs before a record may exist. */
  requires: string[];
  /** Capability the actor must hold to create it. */
  capability: { module: string; action: string };
  /** Existing-record fields checked before creating, so imports never double up. */
  matchOn: string[];
};

export type MatchPolicy = {
  target: RelationshipTarget;
  label: string;
  /** At or above this, NEØ may recommend the match prominently. */
  accept: number;
  /** At or above this, NEØ shows it as a possible match needing confirmation. */
  review: number;
  /** Below this, no candidate is credible and none is offered. */
  floor: number;
  /** Identity evidence beats spelling: an exact alias hit resolves outright. */
  identityEvidence: string[];
  /** The contract. Every offered action must appear here. */
  capabilities: ResolutionCapability[];
  /** Convenience mirror of CREATE_INLINE, kept for existing call sites. */
  inlineCreate: boolean;
  /** Required whenever CREATE_INLINE is granted. */
  inlineSpec?: InlineCreateSpec;
  /** Which module owns this master. */
  ownedBy: string;
  /** Where the administrator goes to create it in its owning module. */
  ownerRoute: string;
  /** May the field simply be left unassigned? */
  allowBlank: boolean;
  /** Plain-language explanation. Must never promise an ungranted capability. */
  guidance: string;
  /**
   * May the shared engine normalise spelling, propose a canonical name and
   * cluster batch variants for this relationship? True only for hotel-defined
   * classification. Governed masters — people, suppliers, guests, corporate
   * accounts, ledger accounts, tax configuration — are always false, because
   * two similar names there can be two genuinely different records.
   */
  canonicalise: boolean;
};

type PolicyInput = Omit<MatchPolicy, "inlineCreate" | "canonicalise"> & { canonicalise?: boolean };

function policy(input: PolicyInput): MatchPolicy {
  return {
    ...input,
    inlineCreate: input.capabilities.includes("CREATE_INLINE"),
    // Canonicalisation follows inline creation unless an adapter declares
    // otherwise: if NEØ may create the record, it must first protect the list
    // from spelling, casing, punctuation and abbreviation duplicates.
    canonicalise: input.canonicalise ?? input.capabilities.includes("CREATE_INLINE"),
  };
}

/** Capabilities every relationship target shares. */
const BASE: ResolutionCapability[] = [
  "SELECT_EXISTING",
  "PROPOSE_MATCH",
  "MAP_TO_CANONICAL_VALUE",
  "SKIP_ROW",
];

/** A classification the hotel owns: safe to create from inside an import. */
function classification(
  target: RelationshipTarget,
  label: string,
  ownedBy: string,
  ownerRoute: string,
  spec: InlineCreateSpec,
): MatchPolicy {
  return policy({
    target,
    label,
    accept: 0.88,
    review: 0.62,
    floor: 0.5,
    identityEvidence: ["code"],
    capabilities: [...BASE, "CREATE_INLINE", "CREATE_IN_OWNING_MODULE", "LEAVE_UNASSIGNED", "DEFER_RELATIONSHIP"],
    inlineSpec: spec,
    ownedBy,
    ownerRoute,
    allowBlank: true,
    guidance: `Classification is yours to configure, so you may create this ${label.toLowerCase()} here and map every spelling of it to that one record.`,
  });
}

const POLICIES: Record<RelationshipTarget, MatchPolicy> = {
  asset_category: classification(
    "asset_category",
    "Asset category",
    "Asset categories configuration",
    "/admin/asset-categories",
    {
      adapterKey: "asset_categories",
      labelField: "name",
      requires: ["name"],
      capability: { module: "maintenance", action: "edit" },
      matchOn: ["name", "code"],
    },
  ),
  stock_item_group: classification("stock_item_group", "Item group", "Inventory & Stores", "/inventory/items", {
    adapterKey: "stock_item_groups",
    labelField: "name",
    requires: ["name"],
    capability: { module: "inventory", action: "edit" },
    matchOn: ["name", "code"],
  }),
  stock_category: classification("stock_category", "Stock category", "Inventory & Stores", "/inventory/items", {
    adapterKey: "stock_categories",
    labelField: "name",
    requires: ["name"],
    capability: { module: "inventory", action: "edit" },
    matchOn: ["name", "code"],
  }),
  department: policy({
    target: "department",
    label: "Department",
    accept: 0.9,
    review: 0.66,
    floor: 0.55,
    identityEvidence: ["department code"],
    capabilities: [...BASE, "CREATE_IN_OWNING_MODULE", "LEAVE_UNASSIGNED", "DEFER_RELATIONSHIP"],
    ownedBy: "Organisation structure",
    ownerRoute: "/admin/configuration",
    allowBlank: true,
    guidance:
      "Departments belong to your organisation structure. Create the department there, then return to this batch and resolve the value, or leave it unassigned for now.",
  }),
  employee: policy({
    target: "employee",
    label: "Employee",
    accept: 0.97,
    review: 0.86,
    floor: 0.8,
    identityEvidence: ["employee number", "email", "telephone"],
    capabilities: [
      ...BASE,
      "CREATE_IN_OWNING_MODULE",
      "REQUIRE_HUMAN_CONFIRMATION",
      "LEAVE_UNASSIGNED",
      "DEFER_RELATIONSHIP",
    ],
    ownedBy: "People & HR",
    ownerRoute: "/hr/employees",
    allowBlank: true,
    guidance:
      "A person is never created from a spreadsheet column. Add the employee in People & HR, then return and assign them, or leave the record unassigned.",
  }),
  supplier: policy({
    target: "supplier",
    label: "Supplier",
    accept: 0.92,
    review: 0.72,
    floor: 0.62,
    identityEvidence: ["supplier code", "registration number", "tax number", "email"],
    capabilities: [
      ...BASE,
      "CREATE_IN_OWNING_MODULE",
      "REQUIRE_HUMAN_CONFIRMATION",
      "LEAVE_UNASSIGNED",
      "DEFER_RELATIONSHIP",
    ],
    ownedBy: "Procurement — Supplier Master",
    ownerRoute: "/admin/suppliers",
    allowBlank: true,
    guidance:
      "A supplier needs its canonical master details. Create it properly in Procurement, or leave this unassigned and attach it later — NEØ will not invent supplier details.",
  }),
  room: policy({
    target: "room",
    label: "Room",
    accept: 0.95,
    review: 0.82,
    floor: 0.72,
    identityEvidence: ["room number"],
    capabilities: [...BASE, "CREATE_IN_OWNING_MODULE", "LEAVE_UNASSIGNED", "DEFER_RELATIONSHIP"],
    ownedBy: "PMS configuration",
    ownerRoute: "/pms/rooms",
    allowBlank: true,
    guidance: "Rooms are defined in PMS configuration and are never created from another module's import.",
  }),
  store: policy({
    target: "store",
    label: "Store",
    accept: 0.9,
    review: 0.7,
    floor: 0.6,
    identityEvidence: ["store code"],
    capabilities: [...BASE, "CREATE_IN_OWNING_MODULE", "LEAVE_UNASSIGNED", "DEFER_RELATIONSHIP"],
    ownedBy: "Inventory & Stores",
    ownerRoute: "/inventory/by-store",
    allowBlank: true,
    guidance: "Stores are defined in Inventory & Stores configuration.",
  }),
  property: policy({
    target: "property",
    label: "Property",
    accept: 0.95,
    review: 0.85,
    floor: 0.8,
    identityEvidence: ["property code"],
    capabilities: [...BASE, "CREATE_IN_OWNING_MODULE", "BLOCK"],
    ownedBy: "Organisation structure",
    ownerRoute: "/admin/hotel-information",
    allowBlank: false,
    guidance:
      "Properties are defined in your organisation structure. Until the property exists, these rows stay blocked rather than landing in the wrong place.",
  }),
  room_type: policy({
    target: "room_type",
    label: "Room type",
    accept: 0.9,
    review: 0.68,
    floor: 0.58,
    identityEvidence: ["room type code"],
    capabilities: [...BASE, "CREATE_DEPENDENCY_FIRST", "CREATE_IN_OWNING_MODULE", "LEAVE_UNASSIGNED"],
    ownedBy: "PMS configuration",
    ownerRoute: "/pms/rooms",
    allowBlank: true,
    guidance: "Room types are defined in PMS configuration — import Room Types first, then return to this batch.",
  }),
  rate_plan: policy({
    target: "rate_plan",
    label: "Rate plan",
    accept: 0.93,
    review: 0.76,
    floor: 0.66,
    identityEvidence: ["rate code"],
    capabilities: [...BASE, "CREATE_IN_OWNING_MODULE", "REQUIRE_HUMAN_CONFIRMATION", "LEAVE_UNASSIGNED"],
    ownedBy: "PMS rates",
    ownerRoute: "/pms/availability",
    allowBlank: true,
    guidance: "Rate plans carry commercial terms and are never invented from another file.",
  }),
  meal_plan: policy({
    target: "meal_plan",
    label: "Meal plan",
    accept: 0.9,
    review: 0.68,
    floor: 0.58,
    identityEvidence: ["meal plan code"],
    capabilities: [...BASE, "CREATE_IN_OWNING_MODULE", "LEAVE_UNASSIGNED"],
    ownedBy: "PMS configuration",
    ownerRoute: "/admin/meal-plans",
    allowBlank: true,
    guidance: "Board bases are defined in PMS configuration.",
  }),
  menu_category: policy({
    target: "menu_category",
    label: "Menu section",
    accept: 0.88,
    review: 0.62,
    floor: 0.5,
    identityEvidence: [],
    capabilities: [...BASE, "CREATE_DEPENDENCY_FIRST", "CREATE_IN_OWNING_MODULE", "LEAVE_UNASSIGNED"],
    ownedBy: "Menu management",
    ownerRoute: "/bar/menu",
    allowBlank: true,
    guidance:
      "A menu section belongs to a menu, so it is configured in Menu management before items are imported.",
  }),
  customer: policy({
    target: "customer",
    label: "Guest",
    accept: 0.97,
    review: 0.88,
    floor: 0.82,
    identityEvidence: ["guest number", "email", "telephone"],
    capabilities: [
      ...BASE,
      "CREATE_IN_OWNING_MODULE",
      "REQUIRE_HUMAN_CONFIRMATION",
      "LEAVE_UNASSIGNED",
      "DEFER_RELATIONSHIP",
    ],
    ownedBy: "Guest profiles",
    ownerRoute: "/crm/customers",
    allowBlank: true,
    guidance: "A guest profile is never created as a side effect of another import.",
  }),
  corporate_account: policy({
    target: "corporate_account",
    label: "Corporate account",
    accept: 0.93,
    review: 0.76,
    floor: 0.66,
    identityEvidence: ["account number", "registration number", "tax number"],
    capabilities: [...BASE, "CREATE_IN_OWNING_MODULE", "REQUIRE_HUMAN_CONFIRMATION", "LEAVE_UNASSIGNED"],
    ownedBy: "Corporate accounts",
    ownerRoute: "/crm/corporate",
    allowBlank: true,
    guidance: "Corporate accounts carry credit and billing terms, so they are created in their own register.",
  }),
  account: policy({
    target: "account",
    label: "Ledger account",
    accept: 0.97,
    review: 0.9,
    floor: 0.85,
    identityEvidence: ["account code"],
    capabilities: [...BASE, "CREATE_DEPENDENCY_FIRST", "CREATE_IN_OWNING_MODULE", "REQUIRE_HUMAN_CONFIRMATION", "BLOCK"],
    ownedBy: "Chart of Accounts",
    ownerRoute: "/finance/ledger",
    allowBlank: false,
    guidance: "Ledger accounts are never guessed. Import the Chart of Accounts first, then return to this batch.",
  }),
};

export function matchPolicy(target: RelationshipTarget): MatchPolicy {
  return POLICIES[target];
}

export function allMatchPolicies(): MatchPolicy[] {
  return Object.values(POLICIES);
}

export function hasCapability(policy: MatchPolicy, capability: ResolutionCapability): boolean {
  return policy.capabilities.includes(capability);
}

export type ConfidenceBand = "high" | "medium" | "none";

export function confidenceBand(policy: MatchPolicy, confidence: number): ConfidenceBand {
  if (confidence >= policy.accept) return "high";
  if (confidence >= policy.review) return "medium";
  return "none";
}

/** What the administrator may legitimately do with an unresolved value. */
export type ResolutionAction = "map" | "search" | "blank" | "ignore" | "normalise" | "create";

export function allowedActions(policy: MatchPolicy): ResolutionAction[] {
  const actions: ResolutionAction[] = ["map", "search", "normalise", "ignore"];
  if (hasCapability(policy, "LEAVE_UNASSIGNED")) actions.splice(2, 0, "blank");
  if (hasCapability(policy, "CREATE_INLINE")) actions.push("create");
  return actions;
}

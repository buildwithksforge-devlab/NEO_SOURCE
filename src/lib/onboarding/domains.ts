/**
 * NEØ Intelligent Data Onboarding — the platform-owned domain catalogue.
 *
 * NEØ, not the hotel, defines what each onboarding domain means: which fields
 * exist, which are required to create a record at all, which are merely
 * recommended, and which are historical enrichment a legacy hotel may never
 * have recorded. A brand-new property can therefore read this catalogue and
 * prepare itself before it has uploaded anything.
 *
 * Nothing in here is hotel specific. No property, supplier, currency, role or
 * amount is named. Aliases are generic industry vocabulary used to *propose*
 * a mapping — they never fabricate a value.
 */

import { EXTRA_DOMAINS } from "./domains-extra";

export type FieldRequirement = "required" | "recommended" | "optional";

export type FieldFormat =
  | "text"
  | "longtext"
  | "integer"
  | "money"
  | "date"
  | "phone"
  | "email"
  | "enum";

/** Masters an imported value must resolve against, instead of being copied as text. */
export type RelationshipTarget =
  | "department"
  | "employee"
  | "supplier"
  | "room"
  | "room_type"
  | "rate_plan"
  | "meal_plan"
  | "store"
  | "stock_item_group"
  | "stock_category"
  | "menu_category"
  | "customer"
  | "corporate_account"
  | "account"
  | "asset_category"
  | "property";

/**
 * Onboarding sequence. A hotel cannot resolve an employee's department before
 * departments exist, nor stock into stores it has not configured, so the
 * catalogue is ordered rather than flat.
 */
export type OnboardingStage = "foundation" | "master" | "commercial" | "opening";

export type DomainField = {
  key: string;
  label: string;
  requirement: FieldRequirement;
  format: FieldFormat;
  /** Plain-language meaning shown in the field guide. */
  meaning: string;
  /** A shape example, never a business fact. */
  example: string;
  /** Legacy column names NEØ recognises when proposing a mapping. */
  aliases: string[];
  enumValues?: string[];
  relationship?: RelationshipTarget;
  /** NEØ may generate this identifier when the hotel opts in. */
  generatable?: boolean;
  /**
   * The value is mapped and resolved, but the destination record has no column
   * for it — it exists so a legacy column is recognised and its relationship
   * settled, rather than being silently dropped as unmapped.
   */
  resolveOnly?: boolean;
};

/**
 * Domain-specific duplicate meaning. "Two rows share a tag" and "two rows
 * share a name and a location" are different claims with different strength,
 * and a domain that legitimately holds managed sets (120 identical plates)
 * must be able to say so.
 */
export type DuplicateRule = {
  key: string;
  label: string;
  fields: string[];
  /** exact = the same record; probable/possible = a human decides. */
  classification: "exact" | "probable" | "possible";
  explain: string;
};

/** How NEØ numbers an identifier it is allowed to generate. */
export type IdentifierPolicy = { prefix: string; padding: number; note?: string };

export type OnboardingDomain = {
  key: string;
  label: string;
  module: string;
  blurb: string;
  /** Where this domain sits in the onboarding sequence. */
  stage?: OnboardingStage;
  /** Domains that should be in place first, so relationships can resolve. */
  dependsOn?: string[];
  /** Whether the import engine can currently write this domain's records. */
  supported: boolean;
  capability: { module: string; action: string };
  /** Which NEØ masters this domain links into. */
  linksTo: RelationshipTarget[];
  fields: DomainField[];
  /**
   * Duplicate identity. Any one combination matching an existing record makes
   * the row a duplicate candidate — never a silent merge.
   */
  duplicateKeys: string[][];
  /** Explainable, domain-aware duplicate rules. Falls back to `duplicateKeys`. */
  duplicateRules?: DuplicateRule[];
  /** Generation rules for identifiers this domain permits NEØ to issue. */
  identifierPolicies?: Record<string, IdentifierPolicy>;
  /** A completed example file, using obviously illustrative values. */
  example: Record<string, string>[];
};

/** Domain duplicate rules, derived from `duplicateKeys` where none are declared. */
export function duplicateRulesFor(domain: OnboardingDomain): DuplicateRule[] {
  if (domain.duplicateRules?.length) return domain.duplicateRules;
  return domain.duplicateKeys.map((fields) => ({
    key: fields.join("+"),
    label: fields.join(" + ").replace(/_/g, " "),
    fields,
    classification: fields.length === 1 ? "exact" : "possible",
    explain: `These rows share the same ${fields.join(" and ").replace(/_/g, " ")}.`,
  }));
}

const ASSET_FIELDS: DomainField[] = [
  {
    key: "asset_tag",
    label: "Asset tag",
    requirement: "recommended",
    format: "text",
    meaning: "The label physically attached to the item. NEØ can generate one where you have none.",
    example: "AST-0001",
    aliases: ["tag", "tag no", "tag number", "asset code", "asset no", "asset number", "barcode", "fixed asset number", "fa number", "item code"],
    generatable: true,
  },
  {
    key: "name",
    label: "Asset name",
    requirement: "required",
    format: "text",
    meaning: "What the item is called. Without it NEØ cannot create the record.",
    example: "Upright Fridge",
    aliases: ["asset", "asset description", "equipment", "equipment name", "equipment description", "item", "item name", "description of asset", "particulars"],
  },
  {
    key: "description",
    label: "Description",
    requirement: "optional",
    format: "longtext",
    meaning: "Any further detail about the item.",
    example: "Twin door, stainless steel",
    aliases: ["details", "notes", "remarks", "specification", "spec"],
  },
  {
    key: "category",
    label: "Category",
    requirement: "recommended",
    format: "text",
    meaning: "Resolved against your Asset Categories.",
    example: "Kitchen Equipment",
    aliases: ["asset category", "class", "classification", "type", "asset type", "group", "asset group"],
    relationship: "asset_category",
  },
  {
    key: "quantity",
    label: "Quantity",
    requirement: "recommended",
    format: "integer",
    meaning: "How many units this record covers. Managed sets (for example 120 plates) use one record with a quantity.",
    example: "1",
    aliases: ["qty", "units", "no of units", "count", "pieces", "pcs"],
  },
  {
    key: "serial_number",
    label: "Serial number",
    requirement: "optional",
    format: "text",
    meaning: "Manufacturer serial. Used to detect duplicates.",
    example: "SN-88213",
    aliases: ["serial", "serial no", "sn", "machine number", "imei"],
  },
  {
    key: "model",
    label: "Model",
    requirement: "optional",
    format: "text",
    meaning: "Manufacturer model designation.",
    example: "RX-220",
    aliases: ["model no", "model number", "variant"],
  },
  {
    key: "manufacturer",
    label: "Manufacturer",
    requirement: "optional",
    format: "text",
    meaning: "Who made the item. Missing values stay missing.",
    example: "—",
    aliases: ["make", "brand", "maker", "oem"],
  },
  {
    key: "purchase_date",
    label: "Purchase date",
    requirement: "optional",
    format: "date",
    meaning: "When the item was acquired.",
    example: "2024-03-18",
    aliases: ["date purchased", "acquisition date", "date acquired", "bought on", "invoice date", "date of purchase"],
  },
  {
    key: "purchase_cost",
    label: "Purchase cost",
    requirement: "optional",
    format: "money",
    meaning: "What it cost. NEØ never estimates this — if your records do not have it, it stays blank.",
    example: "0",
    aliases: ["cost", "acquisition value", "acquisition cost", "value", "purchase price", "price", "amount", "capital cost", "book value"],
  },
  {
    key: "supplier",
    label: "Supplier",
    requirement: "optional",
    format: "text",
    meaning: "Resolved against your Supplier Master.",
    example: "—",
    aliases: ["vendor", "seller", "supplied by", "purchased from", "dealer"],
    relationship: "supplier",
  },
  {
    key: "purchase_reference",
    label: "Purchase reference",
    requirement: "optional",
    format: "text",
    meaning: "Invoice, LPO or voucher reference for the acquisition.",
    example: "—",
    aliases: ["invoice no", "invoice number", "lpo", "lpo no", "po number", "grn", "voucher", "reference"],
  },
  {
    key: "warranty_start",
    label: "Warranty start",
    requirement: "optional",
    format: "date",
    meaning: "Warranty commencement date.",
    example: "—",
    aliases: ["warranty from", "guarantee start"],
  },
  {
    key: "warranty_expiry",
    label: "Warranty expiry",
    requirement: "optional",
    format: "date",
    meaning: "Warranty end date.",
    example: "—",
    aliases: ["warranty to", "warranty end", "warranty expires", "guarantee expiry"],
  },
  {
    key: "department",
    label: "Department",
    requirement: "recommended",
    format: "text",
    meaning: "Resolved against your Department Master — the owning department.",
    example: "Food & Beverage",
    aliases: ["dept", "dept.", "section", "cost centre", "cost center", "unit", "owning department"],
    relationship: "department",
  },
  {
    key: "location_label",
    label: "Location",
    requirement: "recommended",
    format: "text",
    meaning: "Where the item physically sits, in your own words.",
    example: "Main Kitchen",
    aliases: ["location", "place", "where", "site", "area", "position", "room name"],
  },
  {
    key: "room",
    label: "Room",
    requirement: "optional",
    format: "text",
    meaning: "Resolved against PMS rooms when the item lives in a guest room.",
    example: "—",
    aliases: ["room no", "room number", "rm", "unit no"],
    relationship: "room",
  },
  {
    key: "custodian",
    label: "Custodian",
    requirement: "optional",
    format: "text",
    meaning: "Resolved against your Employee Master. May be left unassigned.",
    example: "—",
    aliases: ["assigned to", "responsible", "holder", "issued to", "owner", "staff", "employee"],
    relationship: "employee",
  },
  {
    key: "condition",
    label: "Condition",
    requirement: "recommended",
    format: "enum",
    meaning: "Physical condition of the item.",
    example: "good",
    aliases: ["state", "asset condition", "physical condition"],
    enumValues: ["excellent", "good", "fair", "poor", "unserviceable"],
  },
  {
    key: "status",
    label: "Status",
    requirement: "recommended",
    format: "enum",
    meaning: "Operational status of the item.",
    example: "active",
    aliases: ["asset status", "current status", "availability"],
    enumValues: [
      "active",
      "assigned",
      "in-storage",
      "under-maintenance",
      "out-of-service",
      "lost",
      "disposed",
      "sold",
      "retired",
    ],
  },
  {
    key: "criticality",
    label: "Criticality",
    requirement: "optional",
    format: "enum",
    meaning: "How badly operations suffer when this item fails.",
    example: "normal",
    aliases: ["importance", "priority", "risk"],
    enumValues: ["low", "normal", "high", "critical"],
  },
  {
    key: "last_service_date",
    label: "Last service date",
    requirement: "optional",
    format: "date",
    meaning: "When it was last serviced.",
    example: "—",
    aliases: ["last serviced", "last maintenance", "serviced on"],
  },
  {
    key: "next_service_date",
    label: "Next service date",
    requirement: "optional",
    format: "date",
    meaning: "When it is next due for service.",
    example: "—",
    aliases: ["next service", "next maintenance", "service due"],
  },
  {
    key: "useful_life_months",
    label: "Useful life (months)",
    requirement: "optional",
    format: "integer",
    meaning: "Expected service life in months.",
    example: "—",
    aliases: ["useful life", "life months", "expected life"],
  },
];

export const ONBOARDING_DOMAINS: OnboardingDomain[] = [
  {
    key: "assets",
    label: "Assets & Equipment",
    module: "maintenance",
    stage: "master",
    dependsOn: ["asset_categories", "departments"],
    blurb:
      "Your fixed asset and equipment register — what you own, where it is, who holds it and what condition it is in.",
    supported: true,
    capability: { module: "maintenance", action: "assets.create" },
    linksTo: ["asset_category", "department", "employee", "supplier", "room"],
    fields: ASSET_FIELDS,
    duplicateKeys: [["asset_tag"], ["serial_number"], ["name", "location_label"]],
    duplicateRules: [
      {
        key: "asset_tag",
        label: "Asset tag",
        fields: ["asset_tag"],
        classification: "exact",
        explain: "An asset tag identifies one physical item, so two rows carrying the same tag are the same asset.",
      },
      {
        key: "serial_number",
        label: "Serial number",
        fields: ["serial_number"],
        classification: "probable",
        explain:
          "A manufacturer serial normally identifies one unit, but legacy registers often reuse or mistype it, so NEØ treats this as a probable duplicate only.",
      },
      {
        key: "managed_set",
        label: "Name, category, location and quantity",
        fields: ["name", "category", "location_label", "quantity"],
        classification: "possible",
        explain:
          "Hotels legitimately hold many identical items. Identical name, category, location and quantity may be one managed set entered twice — or two genuine sets.",
      },
    ],
    identifierPolicies: {
      asset_tag: {
        prefix: "AST-",
        padding: 5,
        note: "Asset tags are hotel-assigned labels, so NEØ may issue them. Manufacturer serial numbers are never generated — a missing serial stays missing.",
      },
    },
    example: [
      {
        asset_tag: "AST-0001",
        name: "Upright Fridge",
        category: "Kitchen Equipment",
        quantity: "1",
        serial_number: "SN-88213",
        model: "RX-220",
        manufacturer: "Example Manufacturer",
        purchase_date: "2024-03-18",
        purchase_cost: "0",
        department: "Food & Beverage",
        location_label: "Main Kitchen",
        condition: "good",
        status: "active",
        criticality: "high",
      },
      {
        asset_tag: "",
        name: "Dinner Plate (set)",
        category: "Crockery",
        quantity: "120",
        serial_number: "",
        model: "",
        manufacturer: "",
        purchase_date: "",
        purchase_cost: "",
        department: "Food & Beverage",
        location_label: "Restaurant Store",
        condition: "good",
        status: "in-storage",
        criticality: "low",
      },
    ],
  },
  ...EXTRA_DOMAINS,
];

export const ONBOARDING_STAGES: { key: OnboardingStage; label: string; blurb: string }[] = [
  {
    key: "foundation",
    label: "Hotel foundation",
    blurb: "Structure and configuration everything else resolves against — departments, stores, room types, categories, taxes.",
  },
  {
    key: "master",
    label: "Master data",
    blurb: "The records you operate on every day — staff, rooms, suppliers, stock items, guests, corporate accounts, assets.",
  },
  {
    key: "commercial",
    label: "Commercial data",
    blurb: "What you sell and at what price — rate plans, menu items and on-the-books reservations.",
  },
  {
    key: "opening",
    label: "Opening position",
    blurb: "Where you stand on day one — chart of accounts, opening stock and opening balances.",
  },
];

export function stageOf(domain: OnboardingDomain): OnboardingStage {
  return domain.stage ?? "master";
}

export function domainByKey(key: string): OnboardingDomain | undefined {
  return ONBOARDING_DOMAINS.find((d) => d.key === key);
}

/** The domains a hotel should have in place before this one, in sequence order. */
export function prerequisiteDomains(domain: OnboardingDomain): OnboardingDomain[] {
  const seen = new Set<string>();
  const out: OnboardingDomain[] = [];
  const walk = (keys: string[]) => {
    for (const key of keys) {
      if (key === domain.key || seen.has(key)) continue;
      seen.add(key);
      const dep = ONBOARDING_DOMAINS.find((d) => d.key === key);
      if (!dep) continue;
      walk(dep.dependsOn ?? []);
      out.push(dep);
    }
  };
  walk(domain.dependsOn ?? []);
  return out;
}

/** The catalogue grouped for display, in the order a hotel should work through it. */
export function domainsByStage(): { stage: (typeof ONBOARDING_STAGES)[number]; domains: OnboardingDomain[] }[] {
  return ONBOARDING_STAGES.map((stage) => ({
    stage,
    domains: ONBOARDING_DOMAINS.filter((d) => stageOf(d) === stage.key),
  })).filter((group) => group.domains.length > 0);
}

export function requiredFields(domain: OnboardingDomain): DomainField[] {
  return domain.fields.filter((f) => f.requirement === "required");
}

/** A blank template: the header row only, in the order NEØ documents it. */
export function blankTemplateCsv(domain: OnboardingDomain): string {
  return `${domain.fields.map((f) => f.key).join(",")}\n`;
}

/** A completed example file for hotels that would rather copy than read. */
export function exampleCsv(domain: OnboardingDomain): string {
  const headers = domain.fields.map((f) => f.key);
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = domain.example.map((row) => headers.map((h) => escape(row[h] ?? "")).join(","));
  return [headers.join(","), ...lines].join("\n") + "\n";
}

/**
 * NEØ Intelligent Data Onboarding — destination adapters.
 *
 * The engine never knows how to write a hotel record. Each domain declares,
 * once, where its records live and how a reviewed row becomes a payload:
 *
 *  - the destination table and whether it is property scoped;
 *  - one write rule per column, including which relationships resolve into
 *    foreign keys rather than being copied as text;
 *  - the identifier NEØ may issue when the hotel opts in, and where the run
 *    continues from;
 *  - the columns duplicate protection reads back;
 *  - the tables that make an imported record un-reversible once it has
 *    acquired activity.
 *
 * Nothing here contains a hotel fact. A missing value stays missing: defaults
 * exist only where the database itself requires a value to accept the row.
 */

export type WriteKind = "text" | "number" | "integer" | "date" | "boolean" | "slug" | "relation";

export type WriteRule = {
  /** Destination column. */
  column: string;
  /** Mapped field key the value comes from. */
  from: string;
  kind?: WriteKind;
  /** Only used where the column cannot accept nothing. */
  fallback?: string | number | boolean;
};

export type DomainAdapter = {
  key: string;
  table: string;
  /** Whether a created record carries the active property. */
  branchScoped: boolean;
  /** Whether the destination refuses a record without a property. */
  branchRequired?: boolean;
  /** Columns duplicate protection reads back from existing records. */
  identityColumns: string[];
  /** Maps a duplicate-rule field key to its stored column, where they differ. */
  columnForField?: Record<string, string>;
  /** The identifier NEØ may issue, when the hotel opts in. */
  generated?: { field: string; column: string };
  write: WriteRule[];
  /** Tables whose rows make an imported record un-reversible. */
  dependents?: { table: string; column: string }[];
  /** Query keys to refresh once an import completes. */
  invalidate?: string[];
  /** Destinations that do not record who created the row. */
  noCreatedBy?: boolean;
};

const t = (column: string, from = column): WriteRule => ({ column, from, kind: "text" });
const n = (column: string, from = column): WriteRule => ({ column, from, kind: "number" });
const i = (column: string, from = column): WriteRule => ({ column, from, kind: "integer" });
const d = (column: string, from = column): WriteRule => ({ column, from, kind: "date" });
const rel = (column: string, from: string): WriteRule => ({ column, from, kind: "relation" });

const ADAPTERS: DomainAdapter[] = [
  {
    key: "assets",
    table: "assets",
    branchScoped: true,
    identityColumns: ["asset_tag", "serial_number", "name", "location_label"],
    generated: { field: "asset_tag", column: "asset_tag" },
    write: [
      t("asset_tag"),
      t("name"),
      t("description"),
      rel("category_id", "category"),
      t("serial_number"),
      t("model"),
      t("manufacturer"),
      d("purchase_date"),
      { column: "purchase_cost", from: "purchase_cost", kind: "number", fallback: 0 },
      { column: "quantity", from: "quantity", kind: "number", fallback: 1 },
      rel("supplier_id", "supplier"),
      t("purchase_reference"),
      d("warranty_start"),
      d("warranty_expiry"),
      rel("department_id", "department"),
      t("location_label"),
      rel("room_id", "room"),
      rel("custodian_id", "custodian"),
      { column: "condition", from: "condition", kind: "slug", fallback: "good" },
      { column: "status", from: "status", kind: "slug", fallback: "active" },
      { column: "criticality", from: "criticality", kind: "slug", fallback: "normal" },
      d("last_service_date"),
      d("next_service_date"),
      i("useful_life_months"),
    ],
    dependents: [
      { table: "asset_movements", column: "asset_id" },
      { table: "asset_service_history", column: "asset_id" },
      { table: "maintenance_work_orders", column: "asset_id" },
      { table: "preventive_maintenance_plans", column: "asset_id" },
    ],
    invalidate: ["ops"],
  },
  {
    key: "departments",
    noCreatedBy: true,
    table: "departments",
    branchScoped: true,
    identityColumns: ["name", "code"],
    write: [t("name"), t("code"), t("description"), rel("parent_department_id", "parent_department")],
    dependents: [{ table: "employees", column: "department_id" }],
    invalidate: ["departments"],
  },
  {
    key: "asset_categories",
    noCreatedBy: true,
    table: "asset_categories",
    branchScoped: false,
    identityColumns: ["name", "code"],
    write: [t("name"), t("code"), i("useful_life_months")],
    dependents: [{ table: "assets", column: "category_id" }],
    invalidate: ["ops"],
  },
  {
    key: "room_types",
    table: "room_types",
    branchScoped: true,
    identityColumns: ["name", "code"],
    write: [
      t("name"),
      t("code"),
      t("description"),
      i("max_adults"),
      i("max_children"),
      i("max_occupancy"),
      i("base_occupancy"),
      i("bed_count"),
    ],
    dependents: [{ table: "rooms", column: "room_type_id" }],
    invalidate: ["pms"],
  },
  {
    key: "stock_item_groups",
    table: "stock_item_groups",
    branchScoped: false,
    identityColumns: ["name", "code"],
    write: [t("name"), t("code"), t("description")],
    dependents: [{ table: "stock_categories", column: "group_id" }],
    invalidate: ["inventory"],
  },
  {
    key: "stock_categories",
    noCreatedBy: true,
    table: "stock_categories",
    branchScoped: false,
    identityColumns: ["name", "code"],
    write: [t("name"), t("code"), t("description"), rel("group_id", "group")],
    dependents: [{ table: "stock_items", column: "category_id" }],
    invalidate: ["inventory"],
  },
  {
    key: "stores",
    noCreatedBy: true,
    table: "stock_locations",
    branchScoped: true,
    identityColumns: ["name", "code"],
    write: [t("name"), t("code"), t("location_type"), rel("department_id", "department")],
    dependents: [{ table: "stock_movements", column: "location_id" }],
    invalidate: ["inventory"],
  },
  {
    key: "tax_codes",
    table: "tax_codes",
    branchScoped: true,
    identityColumns: ["name", "code"],
    write: [t("code"), t("name"), n("rate"), { column: "treatment", from: "treatment", kind: "text" }, d("effective_from")],
    invalidate: ["finance"],
  },
  {
    key: "meal_plans",
    table: "meal_plans",
    branchScoped: true,
    identityColumns: ["name", "code"],
    write: [t("code"), t("name"), t("description")],
    dependents: [{ table: "rate_plans", column: "meal_plan_id" }],
    invalidate: ["pms"],
  },
  {
    key: "employees",
    table: "employees",
    branchScoped: true,
    identityColumns: ["employee_number", "work_email", "personal_email", "full_name", "date_of_birth"],
    generated: { field: "employee_number", column: "employee_number" },
    write: [
      t("employee_number"),
      t("full_name"),
      t("preferred_name"),
      t("gender"),
      d("date_of_birth"),
      t("phone"),
      t("personal_email"),
      t("work_email"),
      t("job_title"),
      t("position_grade"),
      t("employment_type"),
      t("employment_status"),
      d("employment_date"),
      rel("department_id", "department"),
      rel("reporting_manager_id", "reporting_manager"),
      t("work_location"),
    ],
    dependents: [
      { table: "attendance_records", column: "employee_id" },
      { table: "employee_documents", column: "employee_id" },
    ],
    invalidate: ["hr", "workforce"],
  },
  {
    key: "rooms",
    table: "rooms",
    branchScoped: true,
    branchRequired: true,
    identityColumns: ["room_number"],
    write: [t("room_number"), rel("room_type_id", "room_type"), t("floor"), t("building"), t("notes")],
    dependents: [{ table: "reservations", column: "room_id" }],
    invalidate: ["pms"],
  },
  {
    key: "suppliers",
    table: "suppliers",
    branchScoped: true,
    identityColumns: ["name", "code", "tax_id"],
    write: [
      t("name"),
      t("code"),
      t("contact_person"),
      t("phone"),
      t("email"),
      t("address"),
      t("tax_id"),
      i("credit_terms_days"),
      t("payment_terms"),
      t("currency"),
    ],
    dependents: [{ table: "purchase_orders", column: "supplier_id" }],
    invalidate: ["procurement"],
  },
  {
    key: "stock_items",
    table: "stock_items",
    branchScoped: true,
    identityColumns: ["name", "sku", "barcode", "base_unit"],
    write: [
      t("name"),
      t("sku"),
      t("barcode"),
      t("description"),
      rel("category_id", "category"),
      t("base_unit"),
      t("purchase_unit"),
      n("purchase_to_base"),
      n("min_level"),
      n("max_level"),
      n("par_level"),
      rel("default_location_id", "default_location"),
      rel("preferred_supplier_id", "preferred_supplier"),
      n("container_volume_ml"),
      t("container_type"),
    ],
    dependents: [{ table: "stock_movements", column: "stock_item_id" }],
    invalidate: ["inventory"],
  },
  {
    key: "guests",
    table: "customers",
    branchScoped: false,
    identityColumns: ["customer_number", "email", "phone", "full_name", "date_of_birth"],
    generated: { field: "customer_number", column: "customer_number" },
    write: [
      t("customer_number"),
      t("full_name"),
      t("customer_type"),
      t("phone"),
      t("email"),
      t("nationality"),
      d("date_of_birth"),
      t("address"),
      t("city"),
      t("country"),
      t("company"),
      rel("corporate_account_id", "corporate_account"),
    ],
    dependents: [{ table: "reservations", column: "customer_id" }],
    invalidate: ["crm"],
  },
  {
    key: "corporate_clients",
    table: "corporate_accounts",
    branchScoped: true,
    identityColumns: ["account_number", "registration_number", "tax_number", "legal_name"],
    generated: { field: "account_number", column: "account_number" },
    columnForField: { legal_name: "legal_name" },
    write: [
      t("account_number"),
      t("legal_name"),
      t("trading_name"),
      t("registration_number"),
      t("tax_number"),
      t("industry"),
      t("phone"),
      t("email"),
      t("address"),
      t("billing_address"),
      rel("account_manager_id", "account_manager"),
    ],
    dependents: [{ table: "reservations", column: "corporate_account_id" }],
    invalidate: ["crm"],
  },
  {
    key: "rates",
    table: "rate_plans",
    branchScoped: true,
    identityColumns: ["name", "code", "room_type_id"],
    columnForField: { room_type: "room_type_id" },
    write: [
      t("name"),
      t("code"),
      t("description"),
      rel("room_type_id", "room_type"),
      rel("meal_plan_id", "meal_plan"),
      n("base_rate"),
      t("currency"),
      n("tax_rate"),
      i("included_occupancy"),
      i("min_stay"),
      i("max_stay"),
      d("valid_from"),
      d("valid_to"),
    ],
    dependents: [{ table: "reservations", column: "rate_plan_id" }],
    invalidate: ["pms"],
  },
  {
    key: "menu_items",
    table: "menu_items",
    branchScoped: true,
    identityColumns: ["name", "sku", "category_id"],
    columnForField: { category: "category_id" },
    write: [
      t("name"),
      t("sku"),
      t("description"),
      rel("category_id", "category"),
      n("base_price"),
      t("currency"),
      n("tax_rate"),
      i("prep_minutes"),
      i("display_order"),
    ],
    invalidate: ["pos", "menu"],
  },
  {
    key: "chart_of_accounts",
    table: "chart_of_accounts",
    branchScoped: false,
    identityColumns: ["code", "name"],
    write: [
      t("code"),
      t("name"),
      { column: "category", from: "category", kind: "slug" },
      t("account_group"),
      rel("parent_id", "parent"),
      t("description"),
      t("currency"),
    ],
    dependents: [{ table: "journal_lines", column: "account_id" }],
    invalidate: ["finance"],
  },
];

export function adapterFor(domainKey: string): DomainAdapter | undefined {
  return ADAPTERS.find((a) => a.key === domainKey);
}

export function allAdapters(): DomainAdapter[] {
  return ADAPTERS;
}

/** The stored column a duplicate rule's field maps to. */
export function columnForField(adapter: DomainAdapter, fieldKey: string): string {
  if (adapter.columnForField?.[fieldKey]) return adapter.columnForField[fieldKey]!;
  const rule = adapter.write.find((w) => w.from === fieldKey);
  return rule?.column ?? fieldKey;
}

function coerce(rule: WriteRule, raw: string | null, resolved: string | null): unknown {
  if (rule.kind === "relation") return resolved;
  if (raw === null || raw === "") return rule.fallback ?? null;
  switch (rule.kind) {
    case "number": {
      const parsed = Number(raw.replace(/,/g, ""));
      return Number.isFinite(parsed) ? parsed : (rule.fallback ?? null);
    }
    case "integer": {
      const parsed = Number(raw.replace(/,/g, ""));
      return Number.isFinite(parsed) ? Math.round(parsed) : (rule.fallback ?? null);
    }
    case "boolean": {
      const yes = /^(y|yes|true|1|active)$/i.test(raw);
      const no = /^(n|no|false|0|inactive)$/i.test(raw);
      return yes ? true : no ? false : (rule.fallback ?? null);
    }
    case "slug":
      return raw.toLowerCase().trim().replace(/\s+/g, "-");
    default:
      return raw;
  }
}

/**
 * Turns one reviewed row into a destination payload. Values the hotel did not
 * supply stay null — the only values NEØ adds are the declared fallbacks the
 * database itself insists on, and an identifier the hotel asked it to issue.
 */
export function buildPayload(
  adapter: DomainAdapter,
  values: Record<string, unknown>,
  resolved: Record<string, string | null>,
  generatedIdentifier?: string | null,
): Record<string, unknown> {
  const text = (key: string): string | null => {
    const value = values[key];
    const out = value === null || value === undefined ? "" : String(value).trim();
    return out ? out : null;
  };

  const payload: Record<string, unknown> = {};
  for (const rule of adapter.write) {
    let raw = text(rule.from);
    if (!raw && adapter.generated && rule.column === adapter.generated.column && generatedIdentifier) {
      raw = generatedIdentifier;
    }
    payload[rule.column] = coerce(rule, raw, resolved[rule.from] ?? null);
  }
  return payload;
}

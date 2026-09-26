/**
 * NEØ Intelligent Data Onboarding — the rest of the platform domain family.
 *
 * Every domain here is a *declaration*, not a second engine: schema, field
 * guide, relationships, validation vocabulary, duplicate meaning, identifier
 * policy and the masters it must resolve against. Upload, profiling, mapping,
 * resolution, planning, import, audit, retry and reversal remain the shared
 * engine's job (`engine.ts`), and the destination write is declared once in
 * `adapters.ts`.
 *
 * Nothing here is hotel specific. No property, currency, supplier, tax rate,
 * department or person is named; examples show shape only.
 */
import type { DomainField, OnboardingDomain, RelationshipTarget } from "./domains";

type FieldInput = {
  key: string;
  label: string;
  requirement?: DomainField["requirement"];
  format?: DomainField["format"];
  meaning: string;
  example?: string;
  aliases?: string[];
  enumValues?: string[];
  relationship?: RelationshipTarget;
  generatable?: boolean;
};

const f = (input: FieldInput): DomainField => ({
  key: input.key,
  label: input.label,
  requirement: input.requirement ?? "optional",
  format: input.format ?? "text",
  meaning: input.meaning,
  example: input.example ?? "—",
  aliases: input.aliases ?? [],
  ...(input.enumValues ? { enumValues: input.enumValues } : {}),
  ...(input.relationship ? { relationship: input.relationship } : {}),
  ...(input.generatable ? { generatable: true } : {}),
});

const NAME = (label: string, aliases: string[]): DomainField =>
  f({ key: "name", label, requirement: "required", meaning: `The name this record is known by. Without it NEØ cannot create the record.`, aliases });

const CODE = (label: string, aliases: string[], requirement: DomainField["requirement"] = "recommended"): DomainField =>
  f({ key: "code", label, requirement, meaning: "A short code your hotel uses for this record.", aliases });

const DESCRIPTION = f({
  key: "description",
  label: "Description",
  format: "longtext",
  meaning: "Free notes carried across from your existing records.",
  aliases: ["notes", "remarks", "details", "comment"],
});

// ---------------------------------------------------------------- foundation

const DEPARTMENT_FIELDS: DomainField[] = [
  NAME("Department name", ["department", "dept", "section", "unit", "cost centre"]),
  CODE("Department code", ["dept code", "code", "abbreviation"]),
  DESCRIPTION,
  f({
    key: "parent_department",
    label: "Reports into",
    meaning: "The parent department, where your structure has one.",
    aliases: ["parent", "parent department", "division", "reports to"],
    relationship: "department",
  }),
];

const ASSET_CATEGORY_FIELDS: DomainField[] = [
  NAME("Category name", ["category", "asset category", "class", "classification", "type"]),
  CODE("Category code", ["category code", "class code"]),
  f({
    key: "useful_life_months",
    label: "Useful life (months)",
    format: "integer",
    meaning: "Default service life for assets in this category.",
    aliases: ["useful life", "life months", "depreciation life"],
  }),
];

const ROOM_TYPE_FIELDS: DomainField[] = [
  NAME("Room type name", ["room type", "type", "category", "accommodation type"]),
  CODE("Room type code", ["type code", "rt code", "short code"], "required"),
  DESCRIPTION,
  f({ key: "max_adults", label: "Maximum adults", format: "integer", meaning: "Most adults the room may hold.", aliases: ["adults", "max adults", "pax"] }),
  f({ key: "max_children", label: "Maximum children", format: "integer", meaning: "Most children the room may hold.", aliases: ["children", "max children"] }),
  f({ key: "max_occupancy", label: "Maximum occupancy", format: "integer", meaning: "Total sleeping capacity.", aliases: ["occupancy", "capacity", "sleeps"] }),
  f({ key: "base_occupancy", label: "Base occupancy", format: "integer", meaning: "Occupancy the standard rate covers.", aliases: ["standard occupancy", "base pax"] }),
  f({ key: "bed_count", label: "Beds", format: "integer", meaning: "Number of beds in the room.", aliases: ["beds", "bed count"] }),
];

const ITEM_GROUP_FIELDS: DomainField[] = [
  NAME("Item group name", ["group", "item group", "family", "main group"]),
  CODE("Group code", ["group code"]),
  DESCRIPTION,
];

const STOCK_CATEGORY_FIELDS: DomainField[] = [
  NAME("Category name", ["category", "item category", "sub group", "classification"]),
  CODE("Category code", ["category code"]),
  DESCRIPTION,
  f({
    key: "group",
    label: "Item group",
    requirement: "recommended",
    meaning: "The wider group this category belongs to.",
    aliases: ["group", "item group", "main group", "family"],
    relationship: "stock_item_group",
  }),
];

const STORE_FIELDS: DomainField[] = [
  NAME("Store name", ["store", "location", "warehouse", "stores", "outlet store"]),
  CODE("Store code", ["store code", "location code"]),
  f({
    key: "location_type",
    label: "Store type",
    meaning: "How this store is used. NEØ keeps your wording rather than reinterpreting it.",
    aliases: ["type", "store type", "location type"],
  }),
  f({
    key: "department",
    label: "Department",
    meaning: "The department that holds this store, where it is departmental.",
    aliases: ["department", "dept", "owner department"],
    relationship: "department",
  }),
];

const TAX_CODE_FIELDS: DomainField[] = [
  CODE("Tax code", ["tax code", "code", "vat code"], "required"),
  NAME("Tax name", ["tax", "tax name", "description", "vat"]),
  f({ key: "rate", label: "Rate (%)", requirement: "recommended", format: "money", meaning: "The percentage applied.", aliases: ["rate", "percent", "percentage", "vat rate"] }),
  f({
    key: "treatment",
    label: "Treatment",
    format: "enum",
    meaning: "How the tax behaves.",
    aliases: ["treatment", "tax treatment", "type"],
    enumValues: ["standard", "zero_rated", "exempt", "withholding", "service_charge"],
  }),
  f({ key: "effective_from", label: "Effective from", format: "date", meaning: "When the rate takes effect.", aliases: ["effective", "valid from", "from date"] }),
];

const MEAL_PLAN_FIELDS: DomainField[] = [
  CODE("Meal plan code", ["code", "plan code", "board code"], "required"),
  NAME("Meal plan name", ["meal plan", "board basis", "plan", "board"]),
  DESCRIPTION,
];

// -------------------------------------------------------------- master data

const EMPLOYEE_FIELDS: DomainField[] = [
  f({
    key: "employee_number",
    label: "Employee number",
    requirement: "recommended",
    meaning: "Your staff number for this person. NEØ can issue one where you have none.",
    aliases: ["employee no", "staff no", "staff number", "payroll number", "emp id", "personnel number"],
    generatable: true,
  }),
  f({ key: "full_name", label: "Full name", requirement: "required", meaning: "The person's full legal name.", aliases: ["name", "employee name", "staff name", "full names"] }),
  f({ key: "preferred_name", label: "Preferred name", meaning: "The name colleagues use.", aliases: ["nickname", "known as", "preferred"] }),
  f({ key: "gender", label: "Gender", meaning: "As recorded in your own register; NEØ never infers it from a name.", aliases: ["gender", "sex"] }),
  f({ key: "date_of_birth", label: "Date of birth", format: "date", meaning: "Date of birth.", aliases: ["dob", "birth date", "date of birth"] }),
  f({ key: "phone", label: "Telephone", format: "phone", meaning: "Personal telephone number.", aliases: ["phone", "mobile", "cell", "telephone", "contact"] }),
  f({ key: "personal_email", label: "Personal email", format: "email", meaning: "Personal email address.", aliases: ["email", "personal email", "private email"] }),
  f({ key: "work_email", label: "Work email", format: "email", meaning: "Work email address.", aliases: ["work email", "company email", "official email"] }),
  f({ key: "job_title", label: "Job title", requirement: "recommended", meaning: "The position held.", aliases: ["title", "position", "designation", "role"] }),
  f({ key: "position_grade", label: "Grade", meaning: "Your internal grade or band.", aliases: ["grade", "band", "level"] }),
  f({ key: "employment_type", label: "Employment terms", meaning: "Permanent, contract, casual and so on, in your own wording.", aliases: ["employment type", "terms", "contract type", "engagement"] }),
  f({ key: "employment_status", label: "Employment status", meaning: "Whether the person is currently employed.", aliases: ["status", "employment status", "active"] }),
  f({ key: "employment_date", label: "Date joined", format: "date", meaning: "Date employment began.", aliases: ["joined", "hire date", "date joined", "start date", "doj"] }),
  f({
    key: "department",
    label: "Department",
    requirement: "recommended",
    meaning: "The department the person works in.",
    aliases: ["department", "dept", "section", "unit"],
    relationship: "department",
  }),
  f({
    key: "reporting_manager",
    label: "Reports to",
    meaning: "The person's line manager, matched against existing staff only.",
    aliases: ["manager", "reports to", "supervisor", "line manager"],
    relationship: "employee",
  }),
  f({ key: "work_location", label: "Work location", meaning: "Where the person is based.", aliases: ["location", "base", "work location", "station"] }),
];

const ROOM_FIELDS: DomainField[] = [
  f({ key: "room_number", label: "Room number", requirement: "required", meaning: "The number or name on the door.", aliases: ["room", "room no", "number", "unit", "room name"] }),
  f({
    key: "room_type",
    label: "Room type",
    requirement: "recommended",
    meaning: "The saleable room type.",
    aliases: ["type", "room type", "category", "accommodation"],
    relationship: "room_type",
  }),
  f({ key: "floor", label: "Floor", meaning: "Floor or level.", aliases: ["floor", "level", "storey"] }),
  f({ key: "building", label: "Building / wing", meaning: "Building, block or wing.", aliases: ["building", "wing", "block", "house"] }),
  f({ key: "notes", label: "Notes", format: "longtext", meaning: "Anything your register records about the room.", aliases: ["notes", "remarks", "comment"] }),
];

const SUPPLIER_FIELDS: DomainField[] = [
  NAME("Supplier name", ["supplier", "vendor", "supplier name", "company", "payee"]),
  CODE("Supplier code", ["supplier code", "vendor code", "account code"]),
  f({ key: "contact_person", label: "Contact person", requirement: "recommended", meaning: "Who you deal with.", aliases: ["contact", "contact person", "attention", "rep"] }),
  f({ key: "phone", label: "Telephone", format: "phone", meaning: "Supplier telephone number.", aliases: ["phone", "tel", "mobile", "contact number"] }),
  f({ key: "email", label: "Email", format: "email", meaning: "Supplier email address.", aliases: ["email", "e-mail", "mail"] }),
  f({ key: "address", label: "Address", format: "longtext", meaning: "Postal or physical address.", aliases: ["address", "location", "physical address"] }),
  f({ key: "tax_id", label: "Tax / PIN number", meaning: "The supplier's tax registration identifier.", aliases: ["tax id", "pin", "vat no", "tax number", "trn"] }),
  f({ key: "credit_terms_days", label: "Credit days", format: "integer", meaning: "Agreed payment days.", aliases: ["credit days", "terms days", "payment days", "net"] }),
  f({ key: "payment_terms", label: "Payment terms", meaning: "Terms in your own wording.", aliases: ["payment terms", "terms"] }),
  f({ key: "currency", label: "Currency", meaning: "The currency you trade in with this supplier.", aliases: ["currency", "ccy"] }),
];

const STOCK_ITEM_FIELDS: DomainField[] = [
  NAME("Item name", ["item", "description", "product", "material", "item name"]),
  f({ key: "sku", label: "SKU", requirement: "recommended", meaning: "Your stock code for the item.", aliases: ["sku", "item code", "stock code", "product code"] }),
  f({ key: "barcode", label: "Barcode", meaning: "Scanned barcode, where you hold one.", aliases: ["barcode", "ean", "upc"] }),
  DESCRIPTION,
  f({
    key: "category",
    label: "Category",
    requirement: "recommended",
    meaning: "The stock category the item belongs to.",
    aliases: ["category", "item category", "class", "sub group"],
    relationship: "stock_category",
  }),
  {
    ...f({
      key: "item_group",
      label: "Item group",
      meaning:
        "The wider group the item's category sits under. NEØ resolves it against your item groups so the category lands in the right family — the item record itself stores the category, not the group.",
      aliases: ["group", "item group", "main group", "family", "item family", "major group"],
      relationship: "stock_item_group",
    }),
    resolveOnly: true,
  },
  f({ key: "base_unit", label: "Base unit", requirement: "recommended", meaning: "The unit you hold stock in.", aliases: ["unit", "uom", "base unit", "stock unit"] }),
  f({ key: "purchase_unit", label: "Purchase unit", meaning: "The unit you buy in.", aliases: ["purchase unit", "order unit", "buying unit"] }),
  f({ key: "purchase_to_base", label: "Units per purchase unit", format: "money", meaning: "How many base units one purchase unit contains.", aliases: ["conversion", "pack size", "units per case", "factor"] }),
  f({ key: "min_level", label: "Minimum level", format: "money", meaning: "Level at which the item is short.", aliases: ["min", "minimum", "min level", "reorder level"] }),
  f({ key: "max_level", label: "Maximum level", format: "money", meaning: "Level you do not hold above.", aliases: ["max", "maximum", "max level"] }),
  f({ key: "par_level", label: "Par level", format: "money", meaning: "Working level for the holding store.", aliases: ["par", "par level"] }),
  f({
    key: "default_location",
    label: "Default store",
    meaning: "Where this item normally lives.",
    aliases: ["store", "location", "default store", "warehouse"],
    relationship: "store",
  }),
  f({
    key: "preferred_supplier",
    label: "Preferred supplier",
    meaning: "The supplier you usually buy from.",
    aliases: ["supplier", "vendor", "preferred supplier"],
    relationship: "supplier",
  }),
  f({ key: "container_volume_ml", label: "Container volume (ml)", format: "money", meaning: "Volume per container, for anything measured by pour.", aliases: ["volume", "ml", "bottle size", "capacity"] }),
  f({
    key: "container_type",
    label: "Container type",
    format: "enum",
    meaning: "The kind of container the item comes in.",
    aliases: ["container", "pack type", "container type"],
    enumValues: ["bottle", "can", "carton", "keg", "other"],
  }),
];

const CUSTOMER_FIELDS: DomainField[] = [
  f({
    key: "customer_number",
    label: "Guest number",
    requirement: "recommended",
    meaning: "Your own guest reference. NEØ can issue one where you have none.",
    aliases: ["guest no", "customer no", "profile no", "guest id", "customer code"],
    generatable: true,
  }),
  f({ key: "full_name", label: "Full name", requirement: "required", meaning: "The guest's full name.", aliases: ["name", "guest name", "customer name", "full names"] }),
  f({ key: "customer_type", label: "Guest type", meaning: "Individual, corporate contact, agent and so on, in your wording.", aliases: ["type", "guest type", "customer type", "segment"] }),
  f({ key: "phone", label: "Telephone", format: "phone", meaning: "Contact telephone number.", aliases: ["phone", "mobile", "tel", "contact"] }),
  f({ key: "email", label: "Email", format: "email", meaning: "Contact email address.", aliases: ["email", "e-mail", "mail"] }),
  f({ key: "nationality", label: "Nationality", meaning: "Nationality as recorded.", aliases: ["nationality", "country of origin"] }),
  f({ key: "date_of_birth", label: "Date of birth", format: "date", meaning: "Date of birth.", aliases: ["dob", "birth date"] }),
  f({ key: "address", label: "Address", format: "longtext", meaning: "Postal or physical address.", aliases: ["address", "street"] }),
  f({ key: "city", label: "City", meaning: "City or town.", aliases: ["city", "town"] }),
  f({ key: "country", label: "Country", meaning: "Country of residence.", aliases: ["country"] }),
  f({ key: "company", label: "Company", meaning: "The company the guest states, as text.", aliases: ["company", "employer", "organisation"] }),
  f({
    key: "corporate_account",
    label: "Corporate account",
    meaning: "The corporate account this guest bills to, matched against existing accounts only.",
    aliases: ["corporate", "account", "company account", "corporate account"],
    relationship: "corporate_account",
  }),
];

const CORPORATE_FIELDS: DomainField[] = [
  f({
    key: "account_number",
    label: "Account number",
    requirement: "recommended",
    meaning: "Your reference for the account. NEØ can issue one where you have none.",
    aliases: ["account no", "account code", "client code", "company code"],
    generatable: true,
  }),
  f({ key: "legal_name", label: "Registered name", requirement: "required", meaning: "The registered legal name of the company.", aliases: ["name", "company", "legal name", "client name", "registered name"] }),
  f({ key: "trading_name", label: "Trading name", meaning: "The name they trade under.", aliases: ["trading name", "brand", "known as"] }),
  f({ key: "registration_number", label: "Registration number", meaning: "Company registration identifier.", aliases: ["registration", "reg no", "company number"] }),
  f({ key: "tax_number", label: "Tax / PIN number", meaning: "Tax registration identifier.", aliases: ["tax no", "pin", "vat no", "tax number"] }),
  f({ key: "industry", label: "Industry", meaning: "Sector, as you record it.", aliases: ["industry", "sector", "business type"] }),
  f({ key: "phone", label: "Telephone", format: "phone", meaning: "Main telephone number.", aliases: ["phone", "tel", "contact"] }),
  f({ key: "email", label: "Email", format: "email", meaning: "Main email address.", aliases: ["email", "e-mail"] }),
  f({ key: "address", label: "Address", format: "longtext", meaning: "Physical address.", aliases: ["address", "location"] }),
  f({ key: "billing_address", label: "Billing address", format: "longtext", meaning: "Where invoices are sent.", aliases: ["billing address", "invoice address"] }),
  f({
    key: "account_manager",
    label: "Account manager",
    meaning: "The employee who owns the relationship, matched against existing staff only.",
    aliases: ["account manager", "owner", "relationship manager", "sales person"],
    relationship: "employee",
  }),
];

// ------------------------------------------------------- commercial data

const RATE_PLAN_FIELDS: DomainField[] = [
  NAME("Rate plan name", ["rate", "rate plan", "plan", "tariff", "package"]),
  CODE("Rate plan code", ["rate code", "plan code", "tariff code"], "required"),
  DESCRIPTION,
  f({
    key: "room_type",
    label: "Room type",
    requirement: "recommended",
    meaning: "The room type this rate applies to.",
    aliases: ["room type", "type", "accommodation"],
    relationship: "room_type",
  }),
  f({
    key: "meal_plan",
    label: "Meal plan",
    meaning: "The board basis included.",
    aliases: ["meal plan", "board", "board basis", "plan"],
    relationship: "meal_plan",
  }),
  f({ key: "base_rate", label: "Base rate", requirement: "recommended", format: "money", meaning: "The published nightly rate.", aliases: ["rate", "price", "amount", "nightly rate", "base rate"] }),
  f({ key: "currency", label: "Currency", meaning: "The currency the rate is published in.", aliases: ["currency", "ccy"] }),
  f({ key: "tax_rate", label: "Tax rate (%)", format: "money", meaning: "Tax percentage applied to the rate.", aliases: ["tax", "vat", "tax rate"] }),
  f({ key: "included_occupancy", label: "Included occupancy", format: "integer", meaning: "How many guests the rate covers.", aliases: ["occupancy", "pax", "included pax"] }),
  f({ key: "min_stay", label: "Minimum stay", format: "integer", meaning: "Minimum nights.", aliases: ["min stay", "minimum nights", "mlos"] }),
  f({ key: "max_stay", label: "Maximum stay", format: "integer", meaning: "Maximum nights.", aliases: ["max stay", "maximum nights"] }),
  f({ key: "valid_from", label: "Valid from", format: "date", meaning: "First date the rate may be sold.", aliases: ["from", "valid from", "start date", "season start"] }),
  f({ key: "valid_to", label: "Valid to", format: "date", meaning: "Last date the rate may be sold.", aliases: ["to", "valid to", "end date", "season end"] }),
];

const MENU_ITEM_FIELDS: DomainField[] = [
  NAME("Item name", ["item", "dish", "product", "menu item", "description"]),
  f({ key: "sku", label: "Item code", meaning: "Your POS code for the item.", aliases: ["code", "sku", "plu", "item code"] }),
  DESCRIPTION,
  f({
    key: "category",
    label: "Menu category",
    requirement: "recommended",
    meaning: "The menu section the item sits in.",
    aliases: ["category", "section", "menu category", "course", "group"],
    relationship: "menu_category",
  }),
  f({ key: "base_price", label: "Selling price", requirement: "recommended", format: "money", meaning: "The price charged before any discount.", aliases: ["price", "selling price", "amount", "rate"] }),
  f({ key: "currency", label: "Currency", meaning: "The currency the price is stated in.", aliases: ["currency", "ccy"] }),
  f({ key: "tax_rate", label: "Tax rate (%)", format: "money", meaning: "Tax percentage applied at sale.", aliases: ["tax", "vat", "tax rate"] }),
  f({ key: "prep_minutes", label: "Preparation minutes", format: "integer", meaning: "Typical preparation time.", aliases: ["prep time", "minutes", "cook time"] }),
  f({ key: "display_order", label: "Display order", format: "integer", meaning: "Where the item appears on the menu.", aliases: ["order", "sort", "sequence", "position"] }),
];

// ---------------------------------------------------------- opening position

const ACCOUNT_FIELDS: DomainField[] = [
  CODE("Account code", ["account code", "gl code", "code", "account no"], "required"),
  NAME("Account name", ["account", "account name", "description", "gl name"]),
  f({
    key: "category",
    label: "Account category",
    requirement: "required",
    format: "enum",
    meaning: "Where the account sits in the financial statements.",
    aliases: ["category", "type", "account type", "classification"],
    enumValues: ["asset", "liability", "equity", "revenue", "cost_of_sales", "operating_expense", "other_income", "other_expense"],
  }),
  f({ key: "account_group", label: "Account group", meaning: "Your own grouping within the category.", aliases: ["group", "sub type", "account group", "class"] }),
  f({
    key: "parent",
    label: "Parent account",
    meaning: "The account above this one in your hierarchy.",
    aliases: ["parent", "parent account", "header", "roll up"],
    relationship: "account",
  }),
  DESCRIPTION,
  f({ key: "currency", label: "Currency", meaning: "The currency the account is kept in.", aliases: ["currency", "ccy"] }),
];

// -------------------------------------------------------------- the family

function planned(domain: Omit<OnboardingDomain, "supported" | "example"> & { example?: Record<string, string>[] }): OnboardingDomain {
  return { ...domain, supported: false, example: domain.example ?? [] };
}

export const EXTRA_DOMAINS: OnboardingDomain[] = [
  // ---- Stage 1: hotel foundation
  {
    key: "departments",
    label: "Departments",
    module: "administration",
    stage: "foundation",
    blurb: "Your operating structure — every other import resolves department names against this list.",
    supported: true,
    capability: { module: "administration", action: "departments.create" },
    linksTo: ["department"],
    dependsOn: [],
    fields: DEPARTMENT_FIELDS,
    duplicateKeys: [["code"], ["name"]],
    example: [{ name: "Example Department", code: "EXD", description: "", parent_department: "" }],
  },
  {
    key: "asset_categories",
    label: "Asset Categories",
    module: "maintenance",
    stage: "foundation",
    blurb: "How you classify equipment, so an asset import can resolve its categories.",
    supported: true,
    capability: { module: "maintenance", action: "assets.create" },
    linksTo: [],
    dependsOn: [],
    fields: ASSET_CATEGORY_FIELDS,
    duplicateKeys: [["code"], ["name"]],
    example: [{ name: "Example Category", code: "EXC", useful_life_months: "60" }],
  },
  {
    key: "room_types",
    label: "Room Types",
    module: "pms",
    stage: "foundation",
    blurb: "Your saleable room types. Rooms and rate plans both resolve against these.",
    supported: true,
    capability: { module: "pms", action: "rooms.create" },
    linksTo: [],
    dependsOn: [],
    fields: ROOM_TYPE_FIELDS,
    duplicateKeys: [["code"], ["name"]],
    example: [{ name: "Example Room Type", code: "EXT", max_adults: "2", max_children: "1", max_occupancy: "3", base_occupancy: "2", bed_count: "1", description: "" }],
  },
  {
    key: "stock_item_groups",
    label: "Item Groups",
    module: "inventory",
    stage: "foundation",
    blurb: "The top level of your stock structure, above categories.",
    supported: true,
    capability: { module: "inventory", action: "items.create" },
    linksTo: [],
    dependsOn: [],
    fields: ITEM_GROUP_FIELDS,
    duplicateKeys: [["code"], ["name"]],
    example: [{ name: "Example Group", code: "EXG", description: "" }],
  },
  {
    key: "stock_categories",
    label: "Stock Categories",
    module: "inventory",
    stage: "foundation",
    blurb: "How your stock is classified beneath its item groups.",
    supported: true,
    capability: { module: "inventory", action: "items.create" },
    linksTo: ["stock_item_group"],
    dependsOn: ["stock_item_groups"],
    fields: STOCK_CATEGORY_FIELDS,
    duplicateKeys: [["code"], ["name"]],
    example: [{ name: "Example Category", code: "EXSC", group: "Example Group", description: "" }],
  },
  {
    key: "stores",
    label: "Stores & Locations",
    module: "inventory",
    stage: "foundation",
    blurb: "Every place stock is held, including departmental and mini stores.",
    supported: true,
    capability: { module: "inventory", action: "items.create" },
    linksTo: ["department"],
    dependsOn: ["departments"],
    fields: STORE_FIELDS,
    duplicateKeys: [["code"], ["name"]],
    example: [{ name: "Example Store", code: "EXS", location_type: "main", department: "Example Department" }],
  },
  {
    key: "tax_codes",
    label: "Tax Codes",
    module: "finance",
    stage: "foundation",
    blurb: "The tax treatments your prices and invoices refer to.",
    supported: true,
    capability: { module: "finance", action: "settings.edit" },
    linksTo: [],
    dependsOn: [],
    fields: TAX_CODE_FIELDS,
    duplicateKeys: [["code"], ["name"]],
    example: [{ code: "EXT1", name: "Example Standard Tax", rate: "0", treatment: "standard", effective_from: "" }],
  },
  {
    key: "meal_plans",
    label: "Meal Plans",
    module: "pms",
    stage: "foundation",
    blurb: "The board bases your rate plans include.",
    supported: true,
    capability: { module: "pms", action: "rates.create" },
    linksTo: [],
    dependsOn: [],
    fields: MEAL_PLAN_FIELDS,
    duplicateKeys: [["code"], ["name"]],
    example: [{ code: "EXM", name: "Example Meal Plan", description: "" }],
  },

  // ---- Stage 2: master data
  {
    key: "employees",
    label: "People & HR",
    module: "hr",
    stage: "master",
    blurb: "Your staff register — identity, department, reporting line and employment terms.",
    supported: true,
    capability: { module: "hr", action: "staff.create" },
    linksTo: ["department", "employee"],
    dependsOn: ["departments"],
    fields: EMPLOYEE_FIELDS,
    duplicateKeys: [["employee_number"], ["work_email"], ["personal_email"], ["full_name", "date_of_birth"]],
    duplicateRules: [
      {
        key: "employee_number",
        label: "Employee number",
        fields: ["employee_number"],
        classification: "exact",
        explain: "A staff number identifies one person, so two rows carrying the same number are the same employee.",
      },
      {
        key: "work_email",
        label: "Work email",
        fields: ["work_email"],
        classification: "exact",
        explain: "A work mailbox belongs to one person.",
      },
      {
        key: "name_dob",
        label: "Name and date of birth",
        fields: ["full_name", "date_of_birth"],
        classification: "probable",
        explain: "The same name and birth date is strong evidence, but NEØ will not merge two people without your confirmation.",
      },
    ],
    identifierPolicies: {
      employee_number: {
        prefix: "EMP-",
        padding: 5,
        note: "Staff numbers are hotel-assigned, so NEØ may issue them. Identity documents and tax numbers are never generated.",
      },
    },
    example: [
      {
        employee_number: "EMP-00001",
        full_name: "Example Person",
        preferred_name: "",
        gender: "",
        date_of_birth: "",
        phone: "",
        personal_email: "",
        work_email: "",
        job_title: "Example Position",
        position_grade: "",
        employment_type: "permanent",
        employment_status: "active",
        employment_date: "2024-01-01",
        department: "Example Department",
        reporting_manager: "",
        work_location: "",
      },
    ],
  },
  {
    key: "rooms",
    label: "Rooms",
    module: "pms",
    stage: "master",
    blurb: "Your physical room inventory, mapped to the room types you have configured.",
    supported: true,
    capability: { module: "pms", action: "rooms.create" },
    linksTo: ["room_type"],
    dependsOn: ["room_types"],
    fields: ROOM_FIELDS,
    duplicateKeys: [["room_number"]],
    duplicateRules: [
      {
        key: "room_number",
        label: "Room number",
        fields: ["room_number"],
        classification: "exact",
        explain: "A room number is unique within a property, so two rows carrying it are the same room.",
      },
    ],
    example: [{ room_number: "000", room_type: "Example Room Type", floor: "0", building: "", notes: "" }],
  },
  {
    key: "suppliers",
    label: "Suppliers",
    module: "procurement",
    stage: "master",
    blurb: "Your supplier master, contacts and payment terms.",
    supported: true,
    capability: { module: "procurement", action: "suppliers.create" },
    linksTo: [],
    dependsOn: [],
    fields: SUPPLIER_FIELDS,
    duplicateKeys: [["code"], ["tax_id"], ["name"]],
    duplicateRules: [
      { key: "code", label: "Supplier code", fields: ["code"], classification: "exact", explain: "A supplier code identifies one supplier account." },
      { key: "tax_id", label: "Tax number", fields: ["tax_id"], classification: "exact", explain: "A tax registration belongs to one legal entity." },
      { key: "name", label: "Supplier name", fields: ["name"], classification: "probable", explain: "Legacy registers often hold the same supplier under slightly different names, so a name match needs your confirmation." },
    ],
    example: [{ name: "Example Supplier", code: "EXSUP", contact_person: "", phone: "", email: "", address: "", tax_id: "", credit_terms_days: "30", payment_terms: "", currency: "" }],
  },
  {
    key: "stock_items",
    label: "Inventory Items",
    module: "inventory",
    stage: "master",
    blurb: "Your stock catalogue — items, units, conversions, categories and holding stores.",
    supported: true,
    capability: { module: "inventory", action: "items.create" },
    linksTo: ["stock_category", "stock_item_group", "store", "supplier"],
    dependsOn: ["stock_item_groups", "stock_categories", "stores", "suppliers"],
    fields: STOCK_ITEM_FIELDS,
    duplicateKeys: [["sku"], ["barcode"], ["name", "base_unit"]],
    duplicateRules: [
      { key: "sku", label: "SKU", fields: ["sku"], classification: "exact", explain: "A stock code identifies one item." },
      { key: "barcode", label: "Barcode", fields: ["barcode"], classification: "exact", explain: "A barcode identifies one packaged item." },
      { key: "name_unit", label: "Name and unit", fields: ["name", "base_unit"], classification: "possible", explain: "Hotels legitimately hold similar items in different sizes, so the same name and unit may still be two items." },
    ],
    example: [
      {
        name: "Example Item",
        sku: "EX-001",
        barcode: "",
        category: "Example Category",
        base_unit: "each",
        purchase_unit: "case",
        purchase_to_base: "12",
        min_level: "0",
        max_level: "0",
        par_level: "0",
        default_location: "Example Store",
        preferred_supplier: "",
        container_volume_ml: "",
        container_type: "",
      },
    ],
  },
  {
    key: "guests",
    label: "Customers & Guests",
    module: "crm",
    stage: "master",
    blurb: "Your guest profiles and contact details, matched conservatively so two people are never merged silently.",
    supported: true,
    capability: { module: "crm", action: "customers.create" },
    linksTo: ["corporate_account"],
    dependsOn: ["corporate_clients"],
    fields: CUSTOMER_FIELDS,
    duplicateKeys: [["customer_number"], ["email"], ["phone"], ["full_name", "date_of_birth"]],
    duplicateRules: [
      { key: "customer_number", label: "Guest number", fields: ["customer_number"], classification: "exact", explain: "Your own guest reference identifies one profile." },
      { key: "email", label: "Email", fields: ["email"], classification: "probable", explain: "A shared mailbox is common in families and companies, so an email match needs confirmation." },
      { key: "phone", label: "Telephone", fields: ["phone"], classification: "possible", explain: "Telephone numbers are frequently shared, so this is only a possible duplicate." },
      { key: "name_dob", label: "Name and date of birth", fields: ["full_name", "date_of_birth"], classification: "probable", explain: "Strong evidence, but never a silent merge." },
    ],
    identifierPolicies: {
      customer_number: { prefix: "GST-", padding: 6, note: "Guest references are hotel-assigned. Passport and identity numbers are never generated." },
    },
    example: [
      {
        customer_number: "GST-000001",
        full_name: "Example Guest",
        customer_type: "individual",
        phone: "",
        email: "",
        nationality: "",
        date_of_birth: "",
        address: "",
        city: "",
        country: "",
        company: "",
        corporate_account: "",
      },
    ],
  },
  {
    key: "corporate_clients",
    label: "Corporate Accounts",
    module: "crm",
    stage: "master",
    blurb: "Your corporate and agent accounts, registration details and billing contacts.",
    supported: true,
    capability: { module: "crm", action: "customers.create" },
    linksTo: ["employee"],
    dependsOn: ["employees"],
    fields: CORPORATE_FIELDS,
    duplicateKeys: [["account_number"], ["registration_number"], ["tax_number"], ["legal_name"]],
    duplicateRules: [
      { key: "account_number", label: "Account number", fields: ["account_number"], classification: "exact", explain: "Your account reference identifies one company account." },
      { key: "registration_number", label: "Registration number", fields: ["registration_number"], classification: "exact", explain: "A company registration belongs to one legal entity." },
      { key: "legal_name", label: "Registered name", fields: ["legal_name"], classification: "probable", explain: "Companies are often entered under variant names, so this needs confirmation." },
    ],
    identifierPolicies: {
      account_number: { prefix: "CORP-", padding: 5, note: "Account references are hotel-assigned. Registration and tax numbers are never generated." },
    },
    example: [
      {
        account_number: "CORP-00001",
        legal_name: "Example Company Limited",
        trading_name: "",
        registration_number: "",
        tax_number: "",
        industry: "",
        phone: "",
        email: "",
        address: "",
        billing_address: "",
        account_manager: "",
      },
    ],
  },

  // ---- Stage 3: commercial data
  {
    key: "rates",
    label: "Rates & Packages",
    module: "pms",
    stage: "commercial",
    blurb: "Your rate plans, their room types, board basis, validity and occupancy rules.",
    supported: true,
    capability: { module: "pms", action: "rates.create" },
    linksTo: ["room_type", "meal_plan"],
    dependsOn: ["room_types", "meal_plans"],
    fields: RATE_PLAN_FIELDS,
    duplicateKeys: [["code"], ["name", "room_type"]],
    example: [
      {
        name: "Example Rate Plan",
        code: "EXRP",
        description: "",
        room_type: "Example Room Type",
        meal_plan: "",
        base_rate: "0",
        currency: "",
        tax_rate: "0",
        included_occupancy: "2",
        min_stay: "1",
        max_stay: "",
        valid_from: "",
        valid_to: "",
      },
    ],
  },
  {
    key: "menu_items",
    label: "Menu Items",
    module: "pos",
    stage: "commercial",
    blurb: "Your sales catalogue — items, sections, prices and tax. Recipes and stock links stay with the menu module.",
    supported: true,
    capability: { module: "pos", action: "menu.create" },
    linksTo: ["menu_category"],
    dependsOn: [],
    fields: MENU_ITEM_FIELDS,
    duplicateKeys: [["sku"], ["name", "category"]],
    duplicateRules: [
      { key: "sku", label: "Item code", fields: ["sku"], classification: "exact", explain: "A POS code identifies one sellable item." },
      { key: "name_category", label: "Name and section", fields: ["name", "category"], classification: "probable", explain: "The same dish name in the same section is usually one item, but outlets do repeat names." },
    ],
    example: [
      { name: "Example Dish", sku: "EX-100", description: "", category: "Example Section", base_price: "0", currency: "", tax_rate: "0", prep_minutes: "", display_order: "" },
    ],
  },

  // ---- Stage 4: opening position
  {
    key: "chart_of_accounts",
    label: "Chart of Accounts",
    module: "finance",
    stage: "opening",
    blurb: "Your general ledger structure — codes, categories and hierarchy.",
    supported: true,
    capability: { module: "finance", action: "settings.edit" },
    linksTo: ["account"],
    dependsOn: [],
    fields: ACCOUNT_FIELDS,
    duplicateKeys: [["code"]],
    duplicateRules: [
      { key: "code", label: "Account code", fields: ["code"], classification: "exact", explain: "A ledger code identifies one account." },
    ],
    example: [{ code: "0000", name: "Example Account", category: "asset", account_group: "", parent: "", description: "", currency: "" }],
  },
  planned({
    key: "reservations",
    label: "Future Reservations",
    module: "pms",
    stage: "commercial",
    blurb: "On-the-books bookings. A reservation is a commitment against inventory, so it is imported only once guests, rooms and rates exist — and through the reservation engine, never a direct write.",
    capability: { module: "pms", action: "reservations.create" },
    linksTo: ["room_type", "room", "rate_plan", "customer"],
    dependsOn: ["rooms", "rates", "guests"],
    fields: [],
    duplicateKeys: [],
  }),
  planned({
    key: "opening_stock",
    label: "Opening Stock",
    module: "inventory",
    stage: "opening",
    blurb: "Your stock position on day one. It moves quantities and value, so it must post through the stock ledger rather than be written as rows.",
    capability: { module: "inventory", action: "counts.create" },
    linksTo: ["store"],
    dependsOn: ["stock_items", "stores"],
    fields: [],
    duplicateKeys: [],
  }),
  planned({
    key: "opening_balances",
    label: "Opening Balances",
    module: "finance",
    stage: "opening",
    blurb: "Your ledger position on day one. Debits and credits must balance inside an open accounting period, so this posts as a journal rather than as rows.",
    capability: { module: "finance", action: "journals.create" },
    linksTo: ["account"],
    dependsOn: ["chart_of_accounts"],
    fields: [],
    duplicateKeys: [],
  }),
];

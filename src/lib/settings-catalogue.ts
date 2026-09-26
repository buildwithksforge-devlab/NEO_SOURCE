import type { LucideIcon } from "lucide-react";
import {
  Bell,
  BrainCircuit,
  Building2,
  CalendarRange,
  ClipboardList,
  Coins,
  ConciergeBell,
  Eye,
  FileText,
  Gauge,
  Globe2,
  Hash,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  MapPin,
  MessageSquare,
  Palette,
  Plug,
  Receipt,
  Salad,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Truck,
  Users,
  UtensilsCrossed,
  Warehouse,
  Workflow,
} from "lucide-react";
import { capabilityForPath, type Capability } from "./capabilities";

/**
 * The Configuration Centre catalogue.
 *
 * Every configuration surface in the workspace is registered here exactly once,
 * grouped into the sixteen enterprise domains operators think in. Each entry resolves
 * its own capability through the shared registry, so the centre can never show
 * a card for a page the route guard would refuse.
 */

export type SettingsScope = "Organisation" | "Property" | "Module";

export type SettingsEntry = {
  label: string;
  description: string;
  icon: LucideIcon;
  scope: SettingsScope;
  /** Navigates to a configuration page. */
  to?: string;
  /** Renders an editable panel inside the centre itself. */
  panel?: "operations" | "numbering" | "approvals" | "security" | "history";
  keywords?: string[];
};

export type SettingsCategory = {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  entries: SettingsEntry[];
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    key: "organisation",
    title: "Organisation",
    description: "Legal identity, departments, regional operating rules and the configuration profile.",
    icon: Building2,
    entries: [
      {
        label: "Hotel information",
        description: "Legal entity, trading name, contacts and tax identity.",
        icon: Building2,
        scope: "Organisation",
        to: "/admin/hotel-information",
        keywords: ["company", "legal", "address", "tax id", "vat"],
      },
      {
        label: "Regional settings",
        description: "Currency, timezone, language, date and number formats.",
        icon: Globe2,
        scope: "Organisation",
        to: "/admin/regional",
        keywords: ["currency", "timezone", "locale", "format"],
      },
      {
        label: "Departments",
        description: "Departments, reporting lines and workload ownership.",
        icon: Building2,
        scope: "Organisation",
        to: "/departments",
        keywords: ["department", "reporting line"],
      },
      {
        label: "Configuration transfer",
        description: "Export, import or reset the complete white-label profile.",
        icon: SlidersHorizontal,
        scope: "Organisation",
        to: "/admin/configuration",
        keywords: ["export", "import", "reset", "backup"],
      },
    ],
  },
  {
    key: "properties",
    title: "Properties",
    description: "Branches, stations and the property-level operational configuration around them.",
    icon: LayoutDashboard,
    entries: [
      {
        label: "Properties & branches",
        description: "Each property, its type, codes and operating status.",
        icon: LayoutDashboard,
        scope: "Organisation",
        to: "/admin/branches",
        keywords: ["branch", "property", "site", "location"],
      },
      {
        label: "Stations",
        description: "Service stations used by POS routing and kitchen dispatch.",
        icon: MapPin,
        scope: "Property",
        to: "/stations",
        keywords: ["station", "outlet", "terminal"],
      },
      {
        label: "Asset categories",
        description:
          "The canonical classification for assets and equipment, shared by maintenance and asset imports.",
        icon: ClipboardList,
        scope: "Organisation",
        to: "/admin/asset-categories",
        keywords: ["asset", "category", "equipment", "classification", "maintenance"],
      },
      {
        label: "Fault categories",
        description:
          "The hotel's own maintenance fault categories, with default priority and response and resolution targets.",
        icon: ClipboardList,
        scope: "Organisation",
        to: "/admin/maintenance-categories",
        keywords: ["maintenance", "fault", "category", "priority", "sla", "response"],
      },
      {
        label: "Cleaning standards",
        description:
          "The hotel's own room-cleaning checklists for departure, stay-over, deep cleaning and turndown, and what a supervisor inspects.",
        icon: ClipboardList,
        scope: "Organisation",
        to: "/admin/housekeeping-standards",
        keywords: ["housekeeping", "cleaning", "checklist", "standard", "sop", "inspection"],
      },
      {
        label: "Linen catalogue",
        description:
          "Every linen item the hotel owns, with its unit, par level and replacement cost, shared by laundry batches, linen movements and loss incidents.",
        icon: ClipboardList,
        scope: "Property",
        to: "/admin/linen-catalogue",
        keywords: ["linen", "laundry", "towel", "sheet", "par", "replacement", "catalogue"],
      },
      {
        label: "Laundry pricing",
        description:
          "What this property charges guests for each laundry item, normal and express. The guest laundry list and every laundry charge read these prices.",
        icon: ClipboardList,
        scope: "Property",
        to: "/admin/laundry-pricing",
        keywords: ["laundry", "price", "pricing", "guest", "wash", "iron", "dry clean", "express", "rate"],
      },
      {
        label: "Partner billing",
        description:
          "Raise a credit invoice against a corporate partner's account, post it to the ledger and send it to the partner in their own portal conversation.",
        icon: ClipboardList,
        scope: "Property",
        to: "/admin/partner-billing",
        keywords: ["partner", "invoice", "credit", "corporate", "billing", "message", "receivable"],
      },
      {
        label: "Partner messages",
        description:
          "Every conversation between this property and its suppliers or corporate partners, with replies that land in the partner's portal.",
        icon: ClipboardList,
        scope: "Property",
        to: "/admin/partner-messages",
        keywords: ["partner", "message", "inbox", "conversation", "reply", "supplier", "chat"],
      },
      {
        label: "Stock policy",
        description:
          "Whether a store may be taken below zero when items are issued or sold, for the group or one property.",
        icon: ClipboardList,
        scope: "Property",
        to: "/admin/stock-policy",
        keywords: ["stock", "inventory", "negative", "policy", "issue", "store"],
      },
      {
        label: "Join NEØ",
        description:
          "Every condition this property must meet before guests can find it on the public NEØ platform, and who controls each one.",
        icon: MapPin,
        scope: "Property",
        to: "/admin/neo-listing",
        keywords: ["neo", "join", "listing", "discovery", "public", "go live", "platform", "directory"],
      },
      {
        label: "Experience Studio",
        description:
          "One place for this property's brand, colours, type, photography, welcome words, customer services, entrances and publishing — with a live preview of what customers see.",
        icon: MapPin,
        scope: "Property",
        to: "/admin/experience-studio",
        keywords: [
          "experience",
          "studio",
          "brand",
          "branding",
          "logo",
          "colour",
          "color",
          "font",
          "theme",
          "preview",
          "publish",
          "guest",
          "rider",
          "partner",
        ],
      },
      {
        label: "Public experience",
        description:
          "Whether this hotel appears in the public NEØ hotel list, which customer services it offers, which entrances are open, and the public links to put on your own website.",
        icon: MapPin,
        scope: "Property",
        to: "/admin/public-experience",
        keywords: [
          "public",
          "guest",
          "customer",
          "website",
          "link",
          "qr",
          "discovery",
          "partner",
          "rider",
          "front door",
        ],
      },
      {
        label: "Partner access",
        description:
          "Give a supplier or corporate client's own contact person access to their private partner portal, and withdraw it again.",
        icon: MapPin,
        scope: "Property",
        to: "/admin/partner-access",
        keywords: ["partner", "supplier", "corporate", "portal", "access", "invite", "vendor"],
      },

      {
        label: "Grounds areas",
        description: "Lawns, car parks, walkways and other grounds areas used by grounds work.",
        icon: MapPin,
        scope: "Property",
        to: "/admin/grounds-areas",
        keywords: ["grounds", "area", "landscaping", "lawn", "garden"],
      },
      {
        label: "Events settings",
        description: "Event types, deposit rules and department readiness.",
        icon: CalendarRange,
        scope: "Module",
        to: "/events/settings",
        keywords: ["event", "banquet", "deposit"],
      },
      {
        label: "Venues",
        description: "Function spaces, capacities and setup styles.",
        icon: MapPin,
        scope: "Property",
        to: "/events/venues",
        keywords: ["venue", "hall", "capacity"],
      },
      {
        label: "Event packages",
        description: "Package definitions, inclusions and pricing.",
        icon: ClipboardList,
        scope: "Property",
        to: "/events/packages",
        keywords: ["package", "inclusion", "pricing"],
      },
      {
        label: "Event resources",
        description: "Equipment and shared resources available for booking.",
        icon: Workflow,
        scope: "Property",
        to: "/events/resources",
        keywords: ["resource", "equipment", "av"],
      },
      {
        label: "Go-live readiness",
        description: "Certify POS, kitchen routing, menus, staffing, approvals, finance and delivery before opening a property.",
        icon: ShieldAlert,
        scope: "Property",
        to: "/admin/go-live",
        keywords: ["go live", "readiness", "certification", "defects", "testing"],
      },
    ],
  },
  {
    key: "front-office",
    title: "Front Office",
    description: "Operating hours, day-end, rooms and guest credit arrangements.",
    icon: ConciergeBell,
    entries: [
      {
        label: "Operating hours & day-end",
        description: "Check-in, check-out, night audit cut-off and fiscal year start.",
        icon: ConciergeBell,
        scope: "Organisation",
        panel: "operations",
        keywords: ["check-in", "check-out", "night audit", "day end", "fiscal"],
      },
      {
        label: "Rooms & room types",
        description: "Inventory of rooms, types and out-of-order handling.",
        icon: LayoutDashboard,
        scope: "Property",
        to: "/rooms",
        keywords: ["room", "type", "inventory"],
      },
      {
        label: "Credit accounts",
        description: "Corporate credit limits, terms and settlement rules.",
        icon: Receipt,
        scope: "Organisation",
        to: "/credit-accounts",
        keywords: ["credit", "corporate", "ledger", "terms"],
      },
    ],
  },
  {
    key: "rates-taxes",
    title: "Rates & Taxes",
    description: "Rate plans, meal plans and the tax treatment applied to what guests are charged.",
    icon: Coins,
    entries: [
      {
        label: "Rate plans",
        description: "Rate plans, seasons, derived rates and meal plan inclusions.",
        icon: Coins,
        scope: "Property",
        to: "/rates",
        keywords: ["rate", "price", "season", "meal plan"],
      },
      {
        label: "Meal plans",
        description: "Board arrangements (room only, B&B, half board) attached to rates and folios.",
        icon: Salad,
        scope: "Property",
        to: "/admin/meal-plans",
        keywords: ["meal plan", "board", "breakfast", "half board", "full board"],
      },
      {
        label: "Tax configuration",
        description: "VAT treatment, tax codes and statutory reporting.",
        icon: Receipt,
        scope: "Organisation",
        to: "/finance/tax",
        keywords: ["vat", "tax", "levy"],
      },
      {
        label: "KRA eTIMS",
        description: "Fiscal device credentials and invoice submission status.",
        icon: Receipt,
        scope: "Organisation",
        to: "/admin/tax-etims",
        keywords: ["etims", "kra", "fiscal"],
      },
    ],
  },
  {
    key: "pos",
    title: "POS & Restaurant",
    description: "Point of sale behaviour, menus and delivery service rules.",
    icon: UtensilsCrossed,
    entries: [
      {
        label: "Point of sale settings",
        description: "Terminals, tax treatment, service charge and void rules.",
        icon: UtensilsCrossed,
        scope: "Module",
        to: "/pos/settings",
        keywords: ["pos", "terminal", "service charge", "tax"],
      },
      {
        label: "Menu management",
        description: "Menus, categories, modifiers and item availability.",
        icon: FileText,
        scope: "Property",
        to: "/pos/menu",
        keywords: ["menu", "item", "modifier", "price"],
      },
      {
        label: "Menu import inspector",
        description: "Review imported menu batches before they go live.",
        icon: ClipboardList,
        scope: "Organisation",
        to: "/admin/menu-imports",
        keywords: ["import", "menu", "upload"],
      },
      {
        label: "Delivery zones & fees",
        description: "Areas each property delivers to, with minimum order, fees and service hours.",
        icon: MapPin,
        scope: "Property",
        to: "/admin/delivery-zones",
        keywords: ["delivery", "zone", "fee", "radius", "rider"],
      },
      {
        label: "Delivery & rider settings",
        description:
          "Payment methods offered, cash on delivery, lead times, proof of delivery and rider tracking.",
        icon: MapPin,
        scope: "Property",
        to: "/admin/delivery-settings",
        keywords: ["delivery", "payment", "cash on delivery", "tracking", "rider", "proof"],
      },
    ],
  },
  {
    key: "kitchen",
    title: "Kitchen & Routing",
    description: "Prep stations, ticket routing and the recipe standards production consumes against.",
    icon: Salad,
    entries: [
      {
        label: "Kitchen settings",
        description: "Prep stations, target timings, waste and quality rules.",
        icon: Salad,
        scope: "Module",
        to: "/kitchen/settings",
        keywords: ["kds", "kitchen", "station", "prep", "routing"],
      },
      {
        label: "Recipes & standards",
        description: "The canonical recipe standard behind each menu item, and what it consumes from stores.",
        icon: ClipboardList,
        scope: "Property",
        to: "/kitchen/recipes",
        keywords: ["recipe", "yield", "portion", "ingredient", "standard"],
      },
    ],
  },
  {
    key: "inventory",
    title: "Inventory & Stores",
    description: "Stock master data, reorder policy, receiving rules and issuing controls.",
    icon: Warehouse,
    entries: [
      {
        label: "Item groups, categories, stock items & stores",
        description:
          "The stock hierarchy — item group, then category, then stock item — and the physical stores that hold them.",
        icon: Warehouse,
        scope: "Property",
        to: "/inventory/items",
        keywords: [
          "item group",
          "category",
          "stock item",
          "store",
          "catalogue",
          "unit",
          "reorder",
          "par",
          "minimum",
          "hierarchy",
        ],
      },

      {
        label: "Stock control",
        description: "Stores, locations, units and valuation method.",
        icon: Warehouse,
        scope: "Module",
        to: "/inventory",
        keywords: ["stock", "inventory", "store", "valuation"],
      },
      {
        label: "Goods receiving",
        description: "Receiving rules, tolerances and GRN handling.",
        icon: ClipboardList,
        scope: "Module",
        to: "/inventory/receiving",
        keywords: ["grn", "receive", "delivery note"],
      },
      {
        label: "Store issues",
        description: "Departmental issuing and consumption posting.",
        icon: Truck,
        scope: "Module",
        to: "/inventory/issues",
        keywords: ["issue", "consumption", "transfer"],
      },
    ],
  },
  {
    key: "procurement",
    title: "Procurement",
    description: "Suppliers and the purchasing workflow that buys what stores hold.",
    icon: ShoppingCart,
    entries: [
      {
        label: "Approval & control policy",
        description:
          "Amount bands, approver order, effective dates and reason requirements for requisitions, purchase orders, variances and supplier invoices, per property.",
        icon: SlidersHorizontal,
        scope: "Property",
        to: "/admin/procurement-policy",
        keywords: [
          "approval",
          "limit",
          "threshold",
          "policy",
          "authority",
          "escalation",
          "procurement",
        ],
      },
      {
        label: "Suppliers",
        description: "Vendors procurement may order from, with their terms and contacts.",
        icon: ShoppingCart,
        scope: "Organisation",
        to: "/admin/suppliers",
        keywords: ["supplier", "vendor", "terms", "contact"],
      },
      {
        label: "Procurement workflow",
        description: "Requisition, RFQ and purchase order workflow, and where each request now stands.",
        icon: SlidersHorizontal,
        scope: "Module",
        to: "/procurement",
        keywords: ["procurement", "rfq", "purchase order", "tolerance", "workflow"],
      },
    ],
  },
  {
    key: "finance",
    title: "Finance",
    description: "The accounting calendar, payables controls and accounting integrations.",
    icon: Coins,
    entries: [
      {
        label: "Financial years & periods",
        description: "The accounting calendar every posting is dated into. Finance cannot post without it.",
        icon: CalendarRange,
        scope: "Organisation",
        to: "/admin/finance-periods",
        keywords: ["financial year", "period", "fiscal", "close", "posting"],
      },
      {
        label: "Payables & 3-way match",
        description: "Supplier invoices matched against the purchase order and the goods actually received.",
        icon: Receipt,
        scope: "Organisation",
        to: "/finance/payables",
        keywords: ["payable", "invoice", "three way match", "discrepancy", "supplier"],
      },
      {
        label: "M-Pesa payments",
        description: "Paybill, till and callback configuration for mobile money.",
        icon: Smartphone,
        scope: "Organisation",
        to: "/admin/payments-mpesa",
        keywords: ["mpesa", "payment", "paybill", "till"],
      },
      {
        label: "Accounting sync",
        description: "External accounting connection and posting mapping.",
        icon: Plug,
        scope: "Organisation",
        to: "/finance/quickbooks",
        keywords: ["quickbooks", "accounting", "sync", "gl"],
      },
    ],
  },
  {
    key: "approvals",
    title: "Approvals",
    description: "Thresholds, authority limits and the escalation rules behind controlled transactions.",
    icon: ShieldAlert,
    entries: [
      {
        label: "Approval thresholds",
        description: "Amounts above which voids, discounts and purchases need approval.",
        icon: ShieldAlert,
        scope: "Organisation",
        panel: "approvals",
        keywords: ["approval", "threshold", "void", "discount", "limit"],
      },
      {
        label: "Approval authority & limits",
        description: "Who may approve each controlled transaction, up to which amount or percentage, and where it escalates.",
        icon: ShieldCheck,
        scope: "Organisation",
        to: "/admin/approval-limits",
        keywords: ["approval", "authority", "escalation", "limit", "write-off", "refund", "discount"],
      },
      {
        label: "Approval routing policy",
        description: "Which role reserves each workflow and which role picks it up when the approver is unavailable or raised it.",
        icon: ShieldCheck,
        scope: "Organisation",
        to: "/admin/approval-routing",
        keywords: ["routing", "approver", "fallback", "reserved", "my work", "policy"],
      },
      {
        label: "Self-approval exceptions",
        description: "Dated, written exceptions to the rule that nobody approves a record they raised themselves.",
        icon: ShieldAlert,
        scope: "Organisation",
        to: "/admin/self-approval-exceptions",
        keywords: ["self approval", "maker checker", "exception", "separation of duties"],
      },
      {
        label: "Rules & escalations",
        description: "Escalation policies and the rules that trigger them.",
        icon: ListChecks,
        scope: "Organisation",
        to: "/automation/rules",
        keywords: ["escalation", "rule", "sla"],
      },
    ],
  },
  {
    key: "crm",
    title: "CRM & Communications",
    description: "Guest data rules, consent, suppression and message templates.",
    icon: MessageSquare,
    entries: [
      {
        label: "Guest CRM settings",
        description: "Loyalty, duplicate handling and guest data quality rules.",
        icon: Users,
        scope: "Module",
        to: "/crm/settings",
        keywords: ["crm", "loyalty", "duplicate", "guest"],
      },
      {
        label: "Marketing settings",
        description: "Campaign defaults, sending windows and attribution.",
        icon: Sparkles,
        scope: "Module",
        to: "/marketing/settings",
        keywords: ["campaign", "marketing", "attribution"],
      },
      {
        label: "Consent management",
        description: "Consent notices, versions and lawful basis records.",
        icon: ShieldCheck,
        scope: "Organisation",
        to: "/marketing/consent",
        keywords: ["consent", "gdpr", "privacy", "opt-in"],
      },
      {
        label: "Suppression list",
        description: "Addresses and numbers excluded from all sending.",
        icon: Bell,
        scope: "Organisation",
        to: "/marketing/suppression",
        keywords: ["suppression", "unsubscribe", "bounce"],
      },
      {
        label: "Communication templates",
        description: "Email, SMS and WhatsApp message templates.",
        icon: MessageSquare,
        scope: "Organisation",
        to: "/admin/communication",
        keywords: ["email", "sms", "whatsapp", "template"],
      },
    ],
  },
  {
    key: "hr",
    title: "Human Resources",
    description: "Employee policy, leave and attendance configuration, and how new accounts start.",
    icon: Users,
    entries: [
      {
        label: "HR settings",
        description: "Employment policy, leave entitlement and attendance rules.",
        icon: Users,
        scope: "Organisation",
        to: "/hr/settings",
        keywords: ["hr", "leave", "attendance", "policy", "employee"],
      },
      {
        label: "Staff accounts",
        description: "Accounts, employment status, property and department assignment.",
        icon: Users,
        scope: "Organisation",
        to: "/users",
        keywords: ["user", "staff", "account", "invite"],
      },
      {
        label: "New user defaults",
        description: "Defaults applied when a new account is provisioned.",
        icon: ClipboardList,
        scope: "Organisation",
        to: "/admin/user-defaults",
        keywords: ["default", "onboarding", "provision"],
      },
    ],
  },
  {
    key: "documents",
    title: "Documents",
    description: "Document numbering and the layouts printed on what guests and suppliers receive.",
    icon: FileText,
    entries: [
      {
        label: "Document numbering",
        description: "Prefixes and padding for invoices, receipts and orders.",
        icon: Hash,
        scope: "Organisation",
        panel: "numbering",
        keywords: ["invoice", "receipt", "prefix", "sequence", "numbering"],
      },
      {
        label: "Document templates",
        description: "Invoice, receipt, quotation and order document layouts.",
        icon: FileText,
        scope: "Organisation",
        to: "/admin/documents",
        keywords: ["document", "invoice layout", "letterhead"],
      },
    ],
  },
  {
    key: "security",
    title: "Security",
    description: "Access policy, roles, audit trail and integrity verification.",
    icon: KeyRound,
    entries: [
      {
        label: "Security policy",
        description: "Password rules, session timeout, lockout and IP restriction.",
        icon: KeyRound,
        scope: "Organisation",
        panel: "security",
        keywords: ["password", "session", "2fa", "lockout", "ip"],
      },
      {
        label: "Roles & permissions",
        description: "Role catalogue, feature templates and effective access.",
        icon: ShieldCheck,
        scope: "Organisation",
        to: "/roles",
        keywords: ["role", "permission", "rbac", "capability"],
      },
      {
        label: "Access matrix",
        description: "Live matrix of every role against every feature capability.",
        icon: ShieldCheck,
        scope: "Organisation",
        to: "/admin/access-matrix",
        keywords: ["matrix", "audit", "capability"],
      },
      {
        label: "Role testing",
        description: "Verify what a role can reach before you assign it.",
        icon: ListChecks,
        scope: "Organisation",
        to: "/admin/role-testing",
        keywords: ["test", "simulate", "verify"],
      },
      {
        label: "Workspace preview",
        description: "See any role's workspace without changing your own access.",
        icon: Eye,
        scope: "Organisation",
        to: "/admin/workspace-preview",
        keywords: ["preview", "impersonate", "simulate"],
      },
      {
        label: "Capability map",
        description: "Developer diagnostics: the capability behind each navigation item and dashboard widget.",
        icon: Eye,
        scope: "Organisation",
        to: "/admin/capability-map",
        keywords: ["diagnostics", "capability", "gate", "developer"],
      },
      {
        label: "Settings change history",
        description: "Who changed these operating rules, and when.",
        icon: ScrollText,
        scope: "Organisation",
        panel: "history",
        keywords: ["history", "change log"],
      },
      {
        label: "Admin audit log",
        description:
          "Who created, edited or deleted each record, with the time, the action and what changed.",
        icon: ScrollText,
        scope: "Organisation",
        to: "/audit-logs",
        keywords: ["audit", "log", "trail", "created", "edited", "deleted", "history", "who changed"],
      },

      {
        label: "Operational integrity",
        description: "Guard violations and scheduled integrity check results.",
        icon: ShieldAlert,
        scope: "Organisation",
        to: "/admin/integrity",
        keywords: ["integrity", "guard", "violation", "check"],
      },
    ],
  },
  {
    key: "integrations",
    title: "Integrations",
    description: "External provider readiness, automation execution and AI configuration.",
    icon: Plug,
    entries: [
      {
        label: "Providers",
        description: "Messaging and payment provider connections and status.",
        icon: Plug,
        scope: "Organisation",
        to: "/automation/providers",
        keywords: ["provider", "sms gateway", "email", "whatsapp", "connection"],
      },
      {
        label: "Automation settings",
        description: "Execution windows, retries and quiet hours.",
        icon: Workflow,
        scope: "Module",
        to: "/automation/settings",
        keywords: ["automation", "retry", "quiet hours"],
      },
      {
        label: "Integration centre",
        description: "Every external integration and its readiness state.",
        icon: Plug,
        scope: "Organisation",
        to: "/platform/integrations",
        keywords: ["integration", "api", "channel manager"],
      },
      {
        label: "Email delivery readiness",
        description: "Authentication email template, sender domain and provider state.",
        icon: Plug,
        scope: "Organisation",
        to: "/admin/email-delivery",
        keywords: ["email", "smtp", "sender", "domain", "verification", "confirmation"],
      },
      {
        label: "AI provider",
        description: "Model provider, credentials and assistant availability.",
        icon: BrainCircuit,
        scope: "Organisation",
        to: "/admin/ai-provider",
        keywords: ["ai", "model", "api key", "assistant"],
      },
      {
        label: "Environments & flags",
        description: "Environment registry and feature flag exposure.",
        icon: Gauge,
        scope: "Organisation",
        to: "/platform/environments",
        keywords: ["environment", "feature flag", "release"],
      },
      {
        label: "Recovery & workspace lifecycle",
        description: "Snapshots, restore drills, provider backup terms, suspension and deletion.",
        icon: Gauge,
        scope: "Organisation",
        to: "/platform/recovery",
        keywords: ["backup", "restore", "recovery", "snapshot", "delete", "offboarding", "export"],
      },
    ],
  },
  {
    key: "branding",
    title: "Branding",
    description: "Visual identity, dashboard appearance and guest-facing app identity.",
    icon: Palette,
    entries: [
      {
        label: "Brand identity",
        description: "Logos, colour palette and typography.",
        icon: Palette,
        scope: "Organisation",
        to: "/admin/brand-identity",
        keywords: ["logo", "colour", "font", "theme", "brand"],
      },
      {
        label: "Dashboard appearance",
        description: "Default dashboard layout, density and widgets.",
        icon: SlidersHorizontal,
        scope: "Organisation",
        to: "/admin/dashboard-appearance",
        keywords: ["dashboard", "layout", "widget", "appearance"],
      },
      {
        label: "Guest, delivery & rider apps",
        description: "App branding, welcome content and published URLs.",
        icon: Smartphone,
        scope: "Organisation",
        to: "/admin/app-branding",
        keywords: ["guest app", "delivery app", "rider", "pwa", "publish"],
      },
    ],
  },
];

/** The capability an entry demands — panels inherit the centre's own capability. */
export function entryCapability(entry: SettingsEntry): Capability | null {
  if (!entry.to) return capabilityForPath("/settings");
  return capabilityForPath(entry.to);
}

export type EntryFilter = (entry: SettingsEntry) => boolean;

/** Categories reduced to the entries the signed-in member may actually open. */
export function visibleCategories(allowed: EntryFilter): SettingsCategory[] {
  return SETTINGS_CATEGORIES.map((category) => ({
    ...category,
    entries: category.entries.filter(allowed),
  })).filter((category) => category.entries.length > 0);
}

/** Free-text search across labels, descriptions and keywords. */
export function matchesQuery(entry: SettingsEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [entry.label, entry.description, ...(entry.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

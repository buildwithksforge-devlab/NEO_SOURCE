import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  BadgePercent,
  BookOpen,
  BedDouble,
  Boxes,
  Building2,
  CalendarRange,
  ChefHat,
  ClipboardCheck,
  ClipboardList,
  ConciergeBell,
  CreditCard,
  Heart,
  LayoutDashboard,
  Megaphone,
  PackageCheck,
  PieChart,
  Receipt,
  Settings,
  ShoppingCart,
  Sparkles,
  Bike,
  Truck,
  UserCog,
  Users,
  Utensils,
  Bell,
  ListChecks,
  Workflow,
  Send,
  Activity,
  AlertTriangle,
  Plug,
  Settings2,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  Building,
  WashingMachine,
  Wrench,
  MapPin,
  Wallet,
  CalendarCheck,
} from "lucide-react";

/** Roles used for role-based access control across the platform. */
export type Role =
  | "owner"
  | "manager"
  | "front-office"
  | "waiter"
  | "kitchen"
  | "housekeeping"
  | "maintenance"
  | "store"
  | "accountant"
  | "marketing"
  | "hr";

export type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  roles: Role[];
  badge?: string;
};

export type NavGroup = {
  title: string;
  items: NavItem[];
};

const ALL: Role[] = [
  "owner",
  "manager",
  "front-office",
  "waiter",
  "kitchen",
  "housekeeping",
  "maintenance",
  "store",
  "accountant",
  "marketing",
  "hr",
];

export const navigation: NavGroup[] = [
  {
    title: "Overview",
    items: [
      { label: "Dashboard", to: "/workspace", icon: LayoutDashboard, roles: ALL },
      { label: "My Personal PIN", to: "/staff-display-code", icon: ShieldCheck, roles: ALL },
      {
        label: "Staff Board",
        to: "/staff-board",
        icon: ClipboardList,
        roles: ["owner", "manager", "accountant", "store", "front-office"],
      },
      {
        label: "NEØ Intelligence",
        to: "/ai-insights",
        icon: Sparkles,
        roles: ["owner", "manager", "marketing", "accountant"],
        badge: "AI",
      },
    ],
  },
  {
    title: "Front Office & PMS",
    items: [
      {
        label: "Front Office",
        to: "/pms",
        icon: ConciergeBell,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Reservations",
        to: "/pms/reservations",
        icon: CalendarRange,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Arrivals",
        to: "/pms/arrivals",
        icon: ConciergeBell,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "In-house",
        to: "/pms/in-house",
        icon: Users,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Departures",
        to: "/pms/departures",
        icon: Receipt,
        roles: ["owner", "manager", "front-office", "accountant"],
      },
      {
        label: "Availability",
        to: "/pms/availability",
        icon: CalendarRange,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Guest Stays",
        to: "/stays",
        icon: CalendarRange,
        roles: ["owner", "manager", "front-office", "housekeeping", "waiter", "kitchen"],
      },
      {
        label: "Room Rack",
        to: "/pms/rack",
        icon: BedDouble,
        roles: ["owner", "manager", "front-office", "housekeeping"],
      },
      {
        label: "Rooms & Types",
        to: "/pms/rooms",
        icon: BedDouble,
        roles: ["owner", "manager", "front-office", "housekeeping"],
      },
      {
        label: "Guest Requests",
        to: "/pms/requests",
        icon: ConciergeBell,
        roles: ["owner", "manager", "front-office", "housekeeping"],
      },
      {
        label: "Transport & Transfers",
        to: "/pms/transport",
        icon: ConciergeBell,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Waitlist",
        to: "/pms/waitlist",
        icon: CalendarRange,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Groups & Blocks",
        to: "/pms/groups",
        icon: Users,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Folios",
        to: "/pms/folios",
        icon: Receipt,
        roles: ["owner", "manager", "front-office", "accountant"],
      },
      {
        label: "Minibar",
        to: "/pms/minibar",
        icon: Receipt,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Desk Tasks",
        to: "/pms/tasks",
        icon: ListChecks,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Front Desk Supplies",
        to: "/pms/supplies",
        icon: PackageCheck,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Requisitions to Stores",
        to: "/pms/requisitions",
        icon: Boxes,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "Front Office Intelligence",
        to: "/pms/reports",
        icon: PieChart,
        roles: ["owner", "manager", "front-office"],
      },
    ],
  },
  {
    title: "Bar",
    items: [
      {
        label: "Bar Dashboard",
        to: "/bar",
        icon: LayoutDashboard,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Bar Display",
        to: "/bar/display",
        icon: ClipboardCheck,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Bar Order Queue",
        to: "/bar/queue",
        icon: ClipboardCheck,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Sell at the Bar",
        to: "/bar/sell",
        icon: Receipt,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Bar Menu",
        to: "/bar/menu",
        icon: BookOpen,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Bar Requisitions",
        to: "/bar/requisitions",
        icon: ClipboardCheck,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Bar Wastage",
        to: "/bar/wastage",
        icon: PieChart,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Station Stock",
        to: "/station-stock",
        icon: ClipboardCheck,
        roles: ["owner", "manager", "waiter"],
      },
    ],
  },
  {
    title: "Food & Beverage",
    items: [
      {
        label: "Restaurant POS",
        to: "/pos",
        icon: Utensils,
        roles: ["owner", "manager", "waiter", "accountant"],
      },
      {
        label: "Restaurant Floor",
        to: "/pos/floor",
        icon: LayoutDashboard,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Orders & Bills",
        to: "/pos/orders",
        icon: Receipt,
        roles: ["owner", "manager", "waiter", "accountant"],
      },
      {
        label: "POS Production Monitor",
        to: "/pos/kds",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen", "waiter"],
      },
      {
        label: "Menu Management",
        to: "/pos/menu",
        icon: Utensils,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Shift & Cash",
        to: "/pos/shifts",
        icon: CreditCard,
        roles: ["owner", "manager", "waiter", "accountant"],
      },
      {
        label: "POS Approvals",
        to: "/pos/approvals",
        icon: ClipboardCheck,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Stores Requisitions",
        to: "/pos/requisitions",
        icon: ClipboardCheck,
        roles: ["owner", "manager", "waiter", "kitchen"],
      },
      {
        label: "Wastage Log",
        to: "/pos/wastage",
        icon: PieChart,
        roles: ["owner", "manager", "waiter", "kitchen"],
      },
      {
        label: "POS Reports",
        to: "/pos/reports",
        icon: PieChart,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "POS Settings",
        to: "/pos/settings",
        icon: Settings2,
        roles: ["owner", "manager"],
      },
      {
        label: "Kitchen Management",
        to: "/kitchen",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Kitchen Display",
        to: "/kitchen/display",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Coffee Display",
        to: "/coffee/display",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Shared Display Controls",
        to: "/production-displays",
        icon: ChefHat,
        roles: ["owner", "manager"],
      },

      {
        label: "Production Overview",
        to: "/production-overview",
        icon: ChefHat,
        roles: ["owner", "manager"],
      },
      {
        label: "Kitchen Queue",
        to: "/kitchen/queue",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Recipes & Standards",
        to: "/kitchen/recipes",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Pastry & Bakery",
        to: "/pastry",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Pastry Display",
        to: "/pastry/display",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Pastry Order Queue",
        to: "/pastry/queue",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Pastry Production",
        to: "/pastry/production",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      {
        label: "Custom Cakes",
        to: "/pastry/custom-cakes",
        icon: ChefHat,
        roles: ["owner", "manager", "kitchen"],
      },
      // Delivery lives in its own section below; it is deliberately not
      // repeated here so one screen never appears twice in the menu.
    ],
  },
  {
    title: "Delivery",
    items: [
      {
        // A rider's own workspace: assigned deliveries, pickup, drop-off and
        // cash collection. It is the only delivery screen a rider can open.
        label: "My Deliveries",
        to: "/rider",
        icon: Bike,
        roles: ["owner", "manager", "waiter"],
      },
      {
        label: "Delivery Dashboard",
        to: "/delivery",
        icon: Truck,
        roles: ["owner", "manager"],
      },
      {
        // Orders waiting for someone to carry them, plus billing once delivered.
        label: "Delivery Queue",
        to: "/delivery/queue",
        icon: Truck,
        roles: ["owner", "manager", "waiter"],
      },
      {
        // PIN state per order: generated, sent, verified, locked — plus recovery.
        label: "Delivery Verification",
        to: "/delivery/verification",
        icon: Truck,
        roles: ["owner", "manager"],
      },
      {
        label: "Delivery Tasks",
        to: "/delivery/tasks",
        icon: ClipboardCheck,
        roles: ["owner", "manager"],
      },
      {
        label: "Delivery Requisitions",
        to: "/delivery/requisitions",
        icon: ClipboardCheck,
        roles: ["owner", "manager"],
      },
      {
        label: "Fleet Maintenance",
        to: "/delivery/maintenance",
        icon: Wrench,
        roles: ["owner", "manager"],
      },
      {
        label: "Delivery Reports",
        to: "/delivery/reports",
        icon: PieChart,
        roles: ["owner", "manager"],
      },
    ],
  },
  {
    title: "Operations",
    items: [
      {
        label: "Housekeeping",
        to: "/housekeeping",
        icon: Sparkles,
        roles: ["owner", "manager", "housekeeping"],
      },
      {
        label: "My Housekeeping Work",
        to: "/housekeeping/my-work",
        icon: Sparkles,
        roles: ["owner", "manager", "housekeeping"],
      },
      {
        label: "Lost & Found",
        to: "/housekeeping/lost-found",
        icon: Sparkles,
        roles: ["owner", "manager", "housekeeping"],
      },
      {
        label: "Cleaning History",
        to: "/housekeeping/history",
        icon: Sparkles,
        roles: ["owner", "manager"],
      },
      {
        label: "Laundry",
        to: "/laundry",
        icon: WashingMachine,
        roles: ["owner", "manager", "housekeeping"],
      },
      {
        label: "My Laundry Work",
        to: "/laundry/my-work",
        icon: WashingMachine,
        roles: ["owner", "manager", "housekeeping"],
      },
      {
        label: "Maintenance",
        to: "/maintenance",
        icon: Wrench,
        roles: ["owner", "manager", "maintenance"],
      },
      {
        label: "My Maintenance Jobs",
        to: "/maintenance/my-jobs",
        icon: Wrench,
        roles: ["owner", "manager", "maintenance"],
      },
      {
        label: "Grounds & Landscaping",
        to: "/maintenance/landscaping",
        icon: Wrench,
        roles: ["owner", "manager", "maintenance"],
      },
      // The landscaping programme plans recurring work; this is the board where
      // the resulting grounds tasks are created, assigned and followed.
      {
        label: "Grounds Work Board",
        to: "/maintenance/grounds",
        icon: Wrench,
        roles: ["owner", "manager", "maintenance"],
      },
      {
        label: "Assets & Equipment",
        to: "/assets",
        icon: Boxes,
        roles: ["owner", "manager", "maintenance"],
      },
      {
        label: "My Grounds Tasks",
        to: "/maintenance/my-tasks",
        icon: Wrench,
        roles: ["owner", "manager", "maintenance"],
      },
      {
        label: "Security",
        to: "/security",
        icon: ShieldCheck,
        roles: ["owner", "manager", "maintenance", "front-office"],
      },
      {
        label: "My Post",
        to: "/security/my-post",
        icon: ShieldCheck,
        roles: ["owner", "manager", "maintenance", "front-office"],
      },
      {
        label: "Security Incidents",
        to: "/security/incidents",
        icon: AlertTriangle,
        roles: ["owner", "manager", "maintenance", "front-office"],
      },
      {
        label: "Visitor Access",
        to: "/security/visitors",
        icon: ClipboardCheck,
        roles: ["owner", "manager", "maintenance", "front-office"],
      },
      {
        label: "Events & Conferences",
        to: "/events",
        icon: Building2,
        roles: ["owner", "manager", "marketing", "kitchen"],
      },
      {
        label: "Banqueting",
        to: "/events/banqueting",
        icon: Building2,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Banquet Service",
        to: "/events/service",
        icon: ClipboardList,
        roles: ["owner", "manager", "marketing", "kitchen"],
      },
      {
        label: "Banquet Payments",
        to: "/events/payments",
        icon: Building2,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Banquet Reconciliation",
        to: "/events/reconciliation",
        icon: Building2,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "My Banqueting Tasks",
        to: "/events/my-tasks",
        icon: ClipboardList,
        roles: ["owner", "manager", "marketing"],
      },
    ],
  },
  {
    title: "Supply Chain",
    items: [
      {
        label: "Inventory & Stores",
        to: "/inventory",
        icon: Boxes,
        roles: ["owner", "manager", "store", "kitchen"],
      },
      {
        label: "Items, Groups & Stores",
        to: "/inventory/items",
        icon: Boxes,
        roles: ["owner", "manager", "store"],
      },
      {
        label: "Stock Levels",
        to: "/inventory/levels",
        icon: Boxes,
        roles: ["owner", "manager", "store", "kitchen"],
      },
      {
        label: "Stock by Store",
        to: "/inventory/by-store",
        icon: Boxes,
        roles: ["owner", "manager", "store", "kitchen"],
      },
      {
        label: "Live Stock",
        to: "/inventory/live",
        icon: Boxes,
        roles: ["owner", "manager", "store", "kitchen"],
      },
      {
        label: "Weekly Report",
        to: "/inventory/weekly-report",
        icon: Boxes,
        roles: ["owner", "manager", "store"],
      },

      {
        label: "Procurement",
        to: "/procurement",
        icon: ShoppingCart,
        roles: ["owner", "manager", "store", "accountant"],
      },
      {
        label: "Procurement Dashboard",
        to: "/procurement/dashboard",
        icon: ClipboardList,
        roles: ["owner", "manager", "store", "accountant"],
      },
      {
        label: "Purchase Requests",
        to: "/procurement/requests",
        icon: ClipboardList,
        roles: ["owner", "manager", "store", "kitchen", "accountant"],
      },
      {
        label: "Purchase Orders",
        to: "/procurement/orders",
        icon: ShoppingCart,
        roles: ["owner", "manager", "store", "accountant"],
      },
      {
        label: "Supplier Portal",
        to: "/procurement/supplier-portal",
        icon: Truck,
        roles: ["owner", "manager", "store", "accountant"],
      },
      {
        label: "Branch Procurement",
        to: "/procurement/branch",
        icon: Boxes,
        roles: ["owner", "manager", "store", "accountant"],
      },
      {
        label: "RFQs & Quotations",
        to: "/procurement/quotations",
        icon: ClipboardList,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Receiving Reconciliation",
        to: "/procurement/reconciliation",
        icon: ClipboardList,
        roles: ["owner", "manager"],
      },
      {
        label: "Goods Receiving",
        to: "/inventory/receiving",
        icon: PackageCheck,
        roles: ["owner", "manager", "store"],
      },
      {
        label: "Department Requests",
        to: "/inventory/requisitions",
        icon: ClipboardList,
        roles: ["owner", "manager", "store"],
      },
      {
        label: "Stock Counts",
        to: "/inventory/counts",
        icon: PackageCheck,
        roles: ["owner", "manager", "store"],
      },
      {
        label: "Stores Tasks",
        to: "/inventory/tasks",
        icon: ClipboardList,
        roles: ["owner", "manager", "store"],
      },
      {
        label: "Store Issues",
        to: "/inventory/issues",
        icon: ArrowLeftRight,
        roles: ["owner", "manager", "store", "kitchen"],
      },
      {
        label: "Store Transfers",
        to: "/inventory/transfers",
        icon: ArrowLeftRight,
        roles: ["owner", "manager", "store"],
      },
      {
        label: "Stock Needs",
        to: "/inventory/needs",
        icon: ClipboardList,
        roles: ["owner", "manager", "store"],
      },
      {
        label: "Complimentary Register",
        to: "/complimentary",
        icon: Receipt,
        roles: ["owner", "manager", "accountant", "waiter", "kitchen"],
      },
    ],
  },
  {
    title: "Commercial",
    items: [
      {
        label: "Finance",
        to: "/finance",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Cashier Till",
        to: "/finance/till",
        icon: Wallet,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Cashier Sessions",
        to: "/finance/sessions",
        icon: Wallet,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "End of Day",
        to: "/finance/eod",
        icon: CalendarCheck,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Finance Posting",
        to: "/finance/posting",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Handoff Replay",
        to: "/finance/outbox",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Commerce Reconciliation",
        to: "/finance/commerce-check",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Till Reconciliation",
        to: "/finance/till-reconciliation",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Supplier Payables",
        to: "/finance/payables",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "AP Three-Way Matching",
        to: "/finance/ap-matching",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Cashier Queue",
        to: "/finance/queue",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Cashbook",
        to: "/finance/cashbook",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Transaction Register",
        to: "/finance/register",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Payment Register",
        to: "/finance/payments",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Revenue",
        to: "/finance/revenue",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Profit & Loss",
        to: "/finance/profit-loss",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Invoices & Receivables",
        to: "/finance/receivables",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Bank Accounts",
        to: "/finance/bank-accounts",
        icon: Wallet,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Payroll Journal",
        to: "/finance/payroll-journal",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "General Ledger",
        to: "/finance/general-ledger",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Deposit Reconciliation",
        to: "/finance/deposits",
        icon: Receipt,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Credit Accounts",
        to: "/credit-accounts",
        icon: CreditCard,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "CRM Dashboard",
        to: "/crm",
        icon: Heart,
        roles: ["owner", "manager", "marketing", "front-office"],
      },
      {
        label: "Customer Directory",
        to: "/crm/customers",
        icon: Users,
        roles: ["owner", "manager", "marketing", "front-office", "waiter"],
      },
      {
        label: "Corporate Accounts",
        to: "/crm/corporate",
        icon: Building2,
        roles: ["owner", "manager", "marketing", "accountant"],
      },
      {
        label: "Loyalty & Rewards",
        to: "/crm/loyalty",
        icon: BadgePercent,
        roles: ["owner", "manager", "marketing", "front-office"],
      },
      {
        label: "Communications",
        to: "/crm/communications",
        icon: Megaphone,
        roles: ["owner", "manager", "marketing", "front-office"],
      },
      {
        label: "Feedback & Complaints",
        to: "/crm/feedback",
        icon: ConciergeBell,
        roles: ["owner", "manager", "marketing", "front-office"],
      },
      {
        label: "Segments",
        to: "/crm/segments",
        icon: PieChart,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Duplicate Review",
        to: "/crm/duplicates",
        icon: ShieldCheck,
        roles: ["owner", "manager"],
      },
      {
        label: "CRM Settings",
        to: "/crm/settings",
        icon: Settings,
        roles: ["owner", "manager"],
      },
    ],
  },
  {
    title: "Marketing & CRM",
    items: [
      {
        label: "Marketing Dashboard",
        to: "/marketing",
        icon: Megaphone,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Leads",
        to: "/marketing/leads",
        icon: Users,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Lead Pipeline",
        to: "/marketing/pipeline",
        icon: Workflow,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Customer Segments",
        to: "/marketing/segments",
        icon: PieChart,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Campaigns",
        to: "/marketing/campaigns",
        icon: Send,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Marketing Calendar",
        to: "/marketing/calendar",
        icon: CalendarRange,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Content & Approvals",
        to: "/marketing/content",
        icon: Megaphone,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Marketing Tasks",
        to: "/marketing/tasks",
        icon: Workflow,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Marketing Supplies",
        to: "/marketing/supplies",
        icon: PieChart,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Automations",
        to: "/marketing/automations",
        icon: Workflow,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Message Templates",
        to: "/marketing/templates",
        icon: MessageSquare,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Promotions & Vouchers",
        to: "/marketing/promotions",
        icon: BadgePercent,
        roles: ["owner", "manager", "marketing", "accountant"],
      },
      {
        label: "Referrals",
        to: "/marketing/referrals",
        icon: Heart,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Reviews & Reputation",
        to: "/marketing/reviews",
        icon: Sparkles,
        roles: ["owner", "manager", "marketing", "front-office"],
      },
      {
        label: "Service Recovery",
        to: "/marketing/recovery",
        icon: AlertTriangle,
        roles: ["owner", "manager", "marketing", "front-office"],
      },
      {
        label: "Feedback Analytics",
        to: "/marketing/feedback",
        icon: Activity,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Audience Consent",
        to: "/marketing/consent",
        icon: ShieldCheck,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Suppression Lists",
        to: "/marketing/suppression",
        icon: Bell,
        roles: ["owner", "manager", "marketing"],
      },
      {
        label: "Campaign Reports",
        to: "/marketing/reports",
        icon: PieChart,
        roles: ["owner", "manager", "marketing", "accountant"],
      },
      {
        label: "Marketing Settings",
        to: "/marketing/settings",
        icon: Settings2,
        roles: ["owner", "manager"],
      },
    ],
  },
  {
    title: "Customer Portal",
    items: [
      {
        label: "My Engagement",
        to: "/my-engagement",
        icon: Heart,
        roles: ALL,
      },
    ],
  },

  {
    title: "Intelligence & Analytics",
    items: [
      {
        label: "Executive Analytics",
        to: "/analytics",
        icon: Sparkles,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "KPI Catalogue",
        to: "/analytics/catalogue",
        icon: PieChart,
        roles: ["owner", "manager", "accountant"],
      },
    ],
  },
  {
    title: "Management",
    items: [
      { label: "Human Resources", to: "/hr", icon: UserCog, roles: ["owner", "manager", "hr"] },
      {
        label: "Approvals",
        to: "/approvals",
        icon: ClipboardCheck,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Reports & BI",
        to: "/reports",
        icon: PieChart,
        roles: ["owner", "manager", "accountant"],
      },
      {
        label: "Rates & Packages",
        to: "/rates",
        icon: BadgePercent,
        roles: ["owner", "manager", "front-office"],
      },
      {
        label: "My Work",
        to: "/my-work",
        icon: ListChecks,
        roles: ALL,
      },
      {
        label: "Tasks",
        to: "/tasks",
        icon: ListChecks,
        roles: ALL,
      },
      {
        label: "Notifications",
        to: "/notifications",
        icon: Bell,
        roles: ALL,
      },
    ],
  },
  {
    title: "Automation & Communications",
    items: [
      {
        label: "Automation Dashboard",
        to: "/automation",
        icon: Workflow,
        roles: ["owner", "manager"],
      },
      {
        label: "Workflows",
        to: "/automation/workflows",
        icon: Workflow,
        roles: ["owner", "manager"],
      },
      {
        label: "Message Templates",
        to: "/automation/templates",
        icon: MessageSquare,
        roles: ["owner", "manager"],
      },
      {
        label: "Communication Queue",
        to: "/automation/queue",
        icon: Send,
        roles: ["owner", "manager"],
      },
      { label: "Event Log", to: "/automation/events", icon: Activity, roles: ["owner", "manager"] },
      {
        label: "Rules & Escalations",
        to: "/automation/rules",
        icon: ListChecks,
        roles: ["owner", "manager"],
      },
      {
        label: "Failed Workflows",
        to: "/automation/failures",
        icon: AlertTriangle,
        roles: ["owner", "manager"],
      },
      { label: "Providers", to: "/automation/providers", icon: Plug, roles: ["owner"] },
      {
        label: "Automation Settings",
        to: "/automation/settings",
        icon: Settings2,
        roles: ["owner"],
      },
    ],
  },
  {
    title: "Administration",
    items: [
      { label: "Users", to: "/users", icon: Users, roles: ["owner", "manager", "hr"] },
      {
        label: "Roles & Permissions",
        to: "/roles",
        icon: ShieldCheck,
        roles: ["owner", "manager"],
      },
      {
        label: "Departments",
        to: "/departments",
        icon: Building,
        roles: ["owner", "manager", "hr"],
      },
      { label: "Stations", to: "/stations", icon: MapPin, roles: ["owner", "manager"] },
      {
        label: "Admin Audit Log",
        to: "/audit-logs",
        icon: ScrollText,
        roles: ["owner", "manager"],
      },
      {
        label: "Configuration Centre",
        to: "/settings",
        icon: Settings,
        roles: ["owner", "manager"],
      },
    ],
  },
  {
    title: "Platform & Readiness",
    items: [
      {
        label: "Go-Live Readiness",
        to: "/platform",
        icon: ShieldCheck,
        roles: ["owner", "manager"],
      },
      { label: "Integration Centre", to: "/platform/integrations", icon: Plug, roles: ["owner"] },
      {
        label: "Printers & Print Queue",
        to: "/platform/printers",
        icon: Plug,
        roles: ["owner", "manager"],
      },
      {
        label: "History & Tenant Migration",
        to: "/platform/data-lifecycle",
        icon: ScrollText,
        roles: ["owner"],
      },
      {
        label: "Environments & Flags",
        to: "/platform/environments",
        icon: Settings2,
        roles: ["owner"],
      },
      { label: "Subscription", to: "/platform/subscription", icon: BadgePercent, roles: ["owner"] },
      {
        label: "Data Migration",
        to: "/platform/migration",
        icon: ScrollText,
        roles: ["owner", "manager"],
      },
      { label: "Recovery Centre", to: "/platform/recovery", icon: ShieldCheck, roles: ["owner"] },
      {
        // What each property is still missing: stations, stores, recipes,
        // bottle sizes, payment providers — with the screen that fixes it.
        label: "Configuration Health",
        to: "/platform/configuration-health",
        icon: ShieldCheck,
        roles: ["owner", "manager"],
      },
      {
        label: "Testing & Defects",
        to: "/platform/quality",
        icon: ListChecks,
        roles: ["owner", "manager"],
      },
      {
        label: "Simulation Centre",
        to: "/platform/simulation",
        icon: ListChecks,
        roles: ["owner"],
      },
      {
        label: "Releases & Monitoring",
        to: "/platform/operations",
        icon: Activity,
        roles: ["owner"],
      },
      {
        // Measured timings for staff actions and live-update lag, against the
        // agreed acceptance targets.
        label: "Performance Monitor",
        to: "/platform/performance",
        icon: Activity,
        roles: ["owner", "manager"],
      },
      { label: "Support & Knowledge", to: "/platform/support", icon: MessageSquare, roles: ALL },
    ],
  },
];

export const roleLabels: Record<Role, string> = {
  owner: "Owner / Director",
  manager: "General Manager",
  "front-office": "Front Office",
  waiter: "Waiter / Cashier",
  kitchen: "Kitchen",
  housekeeping: "Housekeeping",
  maintenance: "Maintenance",
  store: "Stores",
  accountant: "Accountant",
  marketing: "Marketing",
  hr: "Human Resources",
};

export function navigationForRole(role: Role): NavGroup[] {
  return navigation
    .map((group) => ({ ...group, items: group.items.filter((i) => i.roles.includes(role)) }))
    .filter((group) => group.items.length > 0);
}

/**
 * Maps a real role name stored in `public.roles` onto the sidebar role bucket.
 * Unknown roles fall back to the least-privileged bucket the navigation supports.
 */
export function navRoleForRoleNames(roleNames: string[], isAdmin: boolean): Role {
  if (isAdmin) return "owner";
  const names = roleNames.map((n) => n.toLowerCase());
  const has = (...needles: string[]) => names.some((n) => needles.some((x) => n.includes(x)));
  if (has("owner", "director", "system administrator")) return "owner";
  if (has("general manager", "operations manager")) return "manager";
  if (has("front office", "reception", "concierge", "reservations")) return "front-office";
  if (has("finance", "accountant", "cashier")) return "accountant";
  if (has("housekeep", "laundry")) return "housekeeping";
  if (has("kitchen", "chef", "pastry")) return "kitchen";
  if (has("waiter", "waitress", "barista", "bar ", "restaurant")) return "waiter";
  if (has("maintenance", "engineer")) return "maintenance";
  if (has("store", "procurement", "inventory")) return "store";
  if (has("marketing", "events")) return "marketing";
  if (has("human resources", "hr")) return "hr";
  if (has("manager", "supervisor")) return "manager";
  return "front-office";
}

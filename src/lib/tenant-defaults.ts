import type {
  AppBranding,
  AppKey,
  Branch,
  BrandSettings,
  CommunicationTemplate,
  ContactInfo,
  DashboardPreferences,
  DocumentTemplate,
  DocumentTemplateType,
  Organization,
  RegionalSettings,
  TenantState,
} from "./tenant-types";

export const DEMO_ORG_ID = "org_demo";

const now = "2026-01-01T00:00:00.000Z";
const stamps = { createdAt: now, updatedAt: now };

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export const defaultOrganization: Organization = {
  id: DEMO_ORG_ID,
  name: "",
  legalName: "",
  businessType: "hotel",
  description: "",
  onboardingCompleted: false,
  ...stamps,
};

export const defaultContact: ContactInfo = {
  address: "",
  phonePrimary: "",
  phoneSecondary: "",
  email: "",
  website: "",
};

export const defaultBrand: BrandSettings = {
  organizationId: DEMO_ORG_ID,
  primary: "#18C4C8",
  secondary: "#E8EDF3",
  accent: "#D5AF63",
  background: "#F7F9FC",
  foreground: "#020A1C",
  fontKey: "jakarta",
  theme: "light",
  logoLight: null,
  logoDark: null,
  favicon: null,
  dashboardBanner: null,
  splashImage: null,
  logoText: "NEØ",
  ...stamps,
};

export const defaultRegional: RegionalSettings = {
  organizationId: DEMO_ORG_ID,
  country: "Kenya",
  currency: "KES",
  currencySymbol: "KSh",
  timezone: "Africa/Nairobi",
  language: "en",
  dateFormat: "DD/MM/YYYY",
  timeFormat: "24h",
  numberFormat: "1,234.56",
  taxLabel: "VAT",
  taxIdLabel: "KRA PIN",
  taxId: "",
  vatRate: 16,
  pricesIncludeTax: true,
  registrationNumber: "",
  registrationDetails: "",
  ...stamps,
};

export function makeBranch(patch: Partial<Branch> = {}): Branch {
  return {
    id: newId("branch"),
    organizationId: DEMO_ORG_ID,
    name: "",
    code: "",
    address: "",
    phone: "",
    email: "",
    isMain: false,
    active: true,
    logo: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...patch,
  };
}

const communicationSeed: {
  key: string;
  name: string;
  subject: string;
  body: string;
}[] = [
  {
    key: "booking-confirmation",
    name: "Booking confirmation",
    subject: "Your booking at {{hotel_name}} is confirmed",
    body: "Your reservation {{booking_reference}} at {{branch_name}} is confirmed for {{check_in_date}} to {{check_out_date}}. We look forward to hosting you.",
  },
  {
    key: "payment-confirmation",
    name: "Payment confirmation",
    subject: "Payment received — {{booking_reference}}",
    body: "We have received {{amount}} for {{booking_reference}}. Thank you for your payment.",
  },
  {
    key: "reservation-reminder",
    name: "Reservation reminder",
    subject: "Your stay at {{hotel_name}} is coming up",
    body: "A friendly reminder about your reservation {{booking_reference}} arriving {{check_in_date}}.",
  },
  {
    key: "check-in-reminder",
    name: "Check-in reminder",
    subject: "Check-in details for {{check_in_date}}",
    body: "Check-in opens at 14:00 at {{branch_name}}. Reply here if you need an early arrival.",
  },
  {
    key: "event-confirmation",
    name: "Event confirmation",
    subject: "Your event at {{hotel_name}} is confirmed",
    body: "Your event booking {{booking_reference}} on {{check_in_date}} at {{branch_name}} is confirmed.",
  },
  {
    key: "delivery-update",
    name: "Delivery update",
    subject: "Your order is on the way",
    body: "Order {{booking_reference}} from {{branch_name}} is on its way. Total: {{amount}}.",
  },
  {
    key: "review-request",
    name: "Review request",
    subject: "How was your stay?",
    body: "Thank you for staying with us, {{guest_name}}. We would love a short review of your experience at {{branch_name}}.",
  },
  {
    key: "thank-you",
    name: "Thank-you message",
    subject: "Thank you from {{hotel_name}}",
    body: "Thank you for choosing {{hotel_name}}, {{guest_name}}. We hope to welcome you again soon.",
  },
];

export function defaultCommunicationTemplates(): CommunicationTemplate[] {
  return communicationSeed.flatMap((seed) =>
    (["whatsapp", "email", "sms"] as const).map((channel) => ({
      id: `tpl_${channel}_${seed.key}`,
      organizationId: DEMO_ORG_ID,
      channel,
      key: seed.key,
      name: seed.name,
      subject: channel === "email" ? seed.subject : "",
      greeting: "Hello {{guest_name}},",
      body: seed.body,
      signature: "Warm regards,\n{{hotel_name}} Team",
      includeLogo: channel !== "sms",
      includeContact: channel !== "sms",
      includeSocial: channel === "email",
      enabled: true,
      ...stamps,
    })),
  );
}

export const documentTypeLabels: Record<DocumentTemplateType, string> = {
  "tax-invoice": "Tax Invoice",
  receipt: "Receipt",
  quotation: "Quotation",
  "purchase-order": "Purchase Order",
  "delivery-note": "Delivery Note",
  "credit-note": "Credit Note",
  "debit-note": "Debit Note",
  statement: "Statement",
  report: "Report",
  "event-quotation": "Event Quotation",
  "conference-proposal": "Conference Proposal",
};

export function defaultDocumentTemplates(): DocumentTemplate[] {
  return (Object.keys(documentTypeLabels) as DocumentTemplateType[]).map((type) => ({
    id: `doc_${type}`,
    organizationId: DEMO_ORG_ID,
    type,
    name: documentTypeLabels[type],
    headerText: documentTypeLabels[type].toUpperCase(),
    logoPlacement: "left",
    showLogo: true,
    showCompanyInfo: true,
    showBanking: type === "tax-invoice" || type === "statement" || type === "quotation",
    bankingDetails: "Bank name\nAccount name\nAccount number\nBranch / SWIFT",
    showQr: type === "tax-invoice" || type === "receipt",
    terms: "Payment due within 14 days. Goods and services remain property of the issuer until settled.",
    showSignature: true,
    signatureName: "",
    signatureTitle: "Authorised Signatory",
    footerText: "Thank you for your business.",
    ...stamps,
  }));
}

export const appLabels: Record<AppKey, string> = {
  guest: "Guest App",
  delivery: "Delivery App",
  rider: "Rider App",
};

export function defaultAppBranding(): Record<AppKey, AppBranding> {
  const base = (appKey: AppKey): AppBranding => ({
    organizationId: DEMO_ORG_ID,
    appKey,
    appName: appLabels[appKey],
    logo: null,
    icon: null,
    splash: null,
    primary: defaultBrand.primary,
    secondary: defaultBrand.secondary,
    accent: defaultBrand.accent,
    menuStyle: "tabs",
    welcomeTitle: "Welcome",
    welcomeMessage: "Everything you need, in one place.",
    ...stamps,
  });
  return { guest: base("guest"), delivery: base("delivery"), rider: base("rider") };
}

export const defaultDashboard: DashboardPreferences = {
  organizationId: DEMO_ORG_ID,
  sidebarStyle: "dark",
  headerStyle: "translucent",
  backgroundStyle: "ivory",
  cardStyle: "elevated",
  layout: "comfortable",
  welcomeMessage: "Today at a glance",
  chartStyle: "area",
  bannerEnabled: true,
  bannerText: "Welcome back — here is how your properties are performing.",
  widgets: [
    { id: "occupancy", label: "Occupancy", enabled: true },
    { id: "revenue", label: "Revenue", enabled: true },
    { id: "arrivals", label: "Arrivals", enabled: true },
    { id: "departures", label: "Departures", enabled: true },
    { id: "open-orders", label: "Open Orders", enabled: false },
    { id: "pending-approvals", label: "Pending Approvals", enabled: true },
    { id: "inventory-alerts", label: "Inventory Alerts", enabled: false },
    { id: "tasks", label: "Tasks", enabled: true },
    { id: "events", label: "Events", enabled: false },
  ],
  quickActions: ["New reservation", "Walk-in check-in", "New order", "Night audit"],
  ...stamps,
};

export function defaultTenantState(): TenantState {
  return {
    organization: { ...defaultOrganization },
    contact: { ...defaultContact },
    branches: [],
    brand: { ...defaultBrand },
    regional: { ...defaultRegional },
    communicationTemplates: defaultCommunicationTemplates(),
    documentTemplates: defaultDocumentTemplates(),
    appBranding: defaultAppBranding(),
    dashboard: { ...defaultDashboard },
  };
}

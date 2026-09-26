/**
 * Multi-tenant domain models for the Hospitality Operating System.
 *
 * Every business record carries `organizationId` (and `branchId` where the
 * record is branch scoped) plus audit timestamps, so these shapes map 1:1 to
 * the future Supabase tables with row level security per organization.
 */

export type Timestamps = {
  createdAt: string;
  updatedAt: string;
};

export type BusinessType = "hotel" | "lodge" | "resort" | "restaurant" | "conference-centre" | "other";

export const businessTypeLabels: Record<BusinessType, string> = {
  hotel: "Hotel",
  lodge: "Lodge",
  resort: "Resort",
  restaurant: "Restaurant",
  "conference-centre": "Conference Centre",
  other: "Other",
};

/** The tenant root record. One organization = one paying hospitality business. */
export type Organization = Timestamps & {
  id: string;
  name: string;
  legalName: string;
  businessType: BusinessType;
  description: string;
  onboardingCompleted: boolean;
};

export type ContactInfo = {
  address: string;
  phonePrimary: string;
  phoneSecondary: string;
  email: string;
  website: string;
};

export type Branch = Timestamps & {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  isMain: boolean;
  active: boolean;
  logo: string | null;
};

export type ThemePreference = "light" | "dark" | "system";

export type BrandSettings = Timestamps & {
  organizationId: string;
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;
  fontKey: FontKey;
  theme: ThemePreference;
  logoLight: string | null;
  logoDark: string | null;
  favicon: string | null;
  dashboardBanner: string | null;
  splashImage: string | null;
  logoText: string;
};

export type FontKey = "jakarta" | "inter" | "manrope" | "dm-sans" | "playfair";

export const fontOptions: { key: FontKey; label: string; stack: string; note: string }[] = [
  { key: "jakarta", label: "Plus Jakarta Sans", stack: "'Plus Jakarta Sans', system-ui, sans-serif", note: "Warm geometric — default" },
  { key: "inter", label: "Inter", stack: "'Inter', system-ui, sans-serif", note: "Neutral and dense" },
  { key: "manrope", label: "Manrope", stack: "'Manrope', system-ui, sans-serif", note: "Rounded and modern" },
  { key: "dm-sans", label: "DM Sans", stack: "'DM Sans', system-ui, sans-serif", note: "Friendly and compact" },
  { key: "playfair", label: "Playfair Display", stack: "'Playfair Display', Georgia, serif", note: "Editorial luxury" },
];

export type RegionalSettings = Timestamps & {
  organizationId: string;
  country: string;
  currency: string;
  currencySymbol: string;
  timezone: string;
  language: string;
  dateFormat: string;
  timeFormat: "12h" | "24h";
  numberFormat: string;
  taxLabel: string;
  taxIdLabel: string;
  taxId: string;
  vatRate: number;
  pricesIncludeTax: boolean;
  registrationNumber: string;
  registrationDetails: string;
};

export type CommunicationChannel = "whatsapp" | "email" | "sms";

export type CommunicationTemplate = Timestamps & {
  id: string;
  organizationId: string;
  channel: CommunicationChannel;
  key: string;
  name: string;
  subject: string;
  greeting: string;
  body: string;
  signature: string;
  includeLogo: boolean;
  includeContact: boolean;
  includeSocial: boolean;
  enabled: boolean;
};

export type DocumentTemplateType =
  | "tax-invoice"
  | "receipt"
  | "quotation"
  | "purchase-order"
  | "delivery-note"
  | "credit-note"
  | "debit-note"
  | "statement"
  | "report"
  | "event-quotation"
  | "conference-proposal";

export type DocumentTemplate = Timestamps & {
  id: string;
  organizationId: string;
  type: DocumentTemplateType;
  name: string;
  headerText: string;
  logoPlacement: "left" | "center" | "right";
  showLogo: boolean;
  showCompanyInfo: boolean;
  showBanking: boolean;
  bankingDetails: string;
  showQr: boolean;
  terms: string;
  showSignature: boolean;
  signatureName: string;
  signatureTitle: string;
  footerText: string;
};

export type AppKey = "guest" | "delivery" | "rider";

export type AppBranding = Timestamps & {
  organizationId: string;
  appKey: AppKey;
  appName: string;
  logo: string | null;
  icon: string | null;
  splash: string | null;
  primary: string;
  secondary: string;
  accent: string;
  menuStyle: "tabs" | "drawer" | "floating";
  welcomeTitle: string;
  welcomeMessage: string;
};

export type DashboardWidget = {
  id: string;
  label: string;
  enabled: boolean;
};

export type DashboardPreferences = Timestamps & {
  organizationId: string;
  sidebarStyle: "dark" | "light" | "brand";
  headerStyle: "translucent" | "solid" | "brand";
  backgroundStyle: "ivory" | "white" | "soft-grey";
  cardStyle: "elevated" | "flat" | "outlined";
  layout: "comfortable" | "compact" | "wide";
  welcomeMessage: string;
  chartStyle: "area" | "bar" | "line";
  bannerEnabled: boolean;
  bannerText: string;
  widgets: DashboardWidget[];
  quickActions: string[];
};

export type TenantState = {
  organization: Organization;
  contact: ContactInfo;
  branches: Branch[];
  brand: BrandSettings;
  regional: RegionalSettings;
  communicationTemplates: CommunicationTemplate[];
  documentTemplates: DocumentTemplate[];
  appBranding: Record<AppKey, AppBranding>;
  dashboard: DashboardPreferences;
};

export const templateVariables = [
  "{{guest_name}}",
  "{{hotel_name}}",
  "{{booking_reference}}",
  "{{check_in_date}}",
  "{{check_out_date}}",
  "{{amount}}",
  "{{branch_name}}",
];

/**
 * Property-aware document identity resolution.
 *
 * One rule, used by every printable output and by the on-screen preview:
 *
 *   1. If the ACTIVE property carries its own configured branding (logo,
 *      trading name, address, phone, email), the document uses it.
 *   2. Anything the property leaves blank falls back to the organisation.
 *   3. Nothing is ever borrowed from a property that is not the active one —
 *      an unresolved property degrades to organisation-level identity rather
 *      than picking the first branch in the list.
 *
 * The resolver is pure so the fallback ladder can be tested without React.
 */
import type { Branch, BrandSettings, ContactInfo, Organization, RegionalSettings } from "./tenant-types";

export type DocumentIdentity = {
  /** Logo actually printed on the document (property first, organisation second). */
  logo: string | null;
  /** Wordmark shown when no image logo is configured anywhere. */
  logoText: string;
  /** Registered legal entity — always organisation-level. */
  legalName: string;
  /** Customer-facing trading name: the property's own name when it has one. */
  tradingName: string;
  propertyName: string;
  propertyAddress: string;
  propertyPhone: string;
  propertyEmail: string;
  website: string;
  taxLabel: string;
  taxId: string;
  registrationNumber: string;
  currency: string;
  primary: string;
  accent: string;
  /** Which level supplied the mark — used by tests and diagnostics. */
  logoSource: "property" | "organisation" | "none";
  /** Active property id, or null when the workspace is on "All properties". */
  propertyId: string | null;
};

const clean = (value: unknown): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : "";

export type DocumentIdentityInput = {
  organization: Pick<Organization, "name" | "legalName">;
  contact?: Partial<ContactInfo> | null;
  regional?: Partial<RegionalSettings> | null;
  brand: Pick<BrandSettings, "primary" | "accent" | "logoText">;
  /** Organisation mark already resolved for the current appearance. */
  organisationLogo?: string | null;
  /** The ACTIVE property only. Never pass a fallback branch. */
  property?: Branch | null;
};

export function resolveDocumentIdentity({
  organization,
  contact,
  regional,
  brand,
  organisationLogo,
  property,
}: DocumentIdentityInput): DocumentIdentity {
  const propertyLogo = clean(property?.logo);
  const orgLogo = clean(organisationLogo);
  const orgName = clean(organization.name);
  const legalName = clean(organization.legalName) || orgName || "Not Configured";
  const propertyName = clean(property?.name);

  return {
    logo: propertyLogo || orgLogo || null,
    logoText: clean(brand.logoText) || "NEØ",
    legalName,
    tradingName: propertyName || orgName || legalName,
    propertyName,
    propertyAddress: clean(property?.address) || clean(contact?.address),
    propertyPhone: clean(property?.phone) || clean(contact?.phonePrimary),
    propertyEmail: clean(property?.email) || clean(contact?.email),
    website: clean(contact?.website),
    taxLabel: clean(regional?.taxIdLabel) || "Tax ID",
    taxId: clean(regional?.taxId),
    registrationNumber: clean(regional?.registrationNumber),
    currency: clean(regional?.currency) || "KES",
    primary: brand.primary,
    accent: brand.accent,
    logoSource: propertyLogo ? "property" : orgLogo ? "organisation" : "none",
    propertyId: property?.id ?? null,
  };
}

/**
 * One money format for every document type: no screen uses a different
 * separator, decimal count or currency position from the printed page.
 */
export function formatDocumentMoney(value: unknown, currency: string): string {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${currency} ${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric)}`;
}

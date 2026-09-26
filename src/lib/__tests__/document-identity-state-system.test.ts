/**
 * Contract for the shared branding + state layer.
 *
 * Branding: documents lead with the ACTIVE property's identity and fall back
 * field-by-field to the organisation. No document ever borrows a mark from a
 * property that is not the active one.
 *
 * States: users never see raw database internals (column names, relation
 * names, PostgREST codes) in an error surface.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveDocumentIdentity } from "../document-identity";
import { sanitizeErrorMessage } from "@/components/common/StateSystem";
import type { Branch } from "../tenant-types";

const brand = { primary: "#18C4C8", accent: "#D5AF63", logoText: "NEØ" };
const organization = { name: "Savannah Crown", legalName: "Savannah Crown Limited" };
const contact = {
  address: "Head office, Nairobi",
  phonePrimary: "+254700000000",
  email: "hq@example.com",
  website: "example.com",
};

const property = (over: Partial<Branch>): Branch =>
  ({
    id: "prop-1",
    name: "Savannah Crown Westlands",
    code: "SCW",
    ...over,
  }) as Branch;

describe("document identity — property over organisation", () => {
  it("falls back to organisation identity when no property is active", () => {
    const id = resolveDocumentIdentity({
      organization,
      contact,
      brand,
      organisationLogo: "org-logo.png",
      property: null,
    });
    expect(id.logo).toBe("org-logo.png");
    expect(id.logoSource).toBe("organisation");
    expect(id.tradingName).toBe("Savannah Crown");
    expect(id.propertyAddress).toBe("Head office, Nairobi");
    expect(id.propertyId).toBeNull();
  });

  it("prefers the active property's own logo, name and contact details", () => {
    const id = resolveDocumentIdentity({
      organization,
      contact,
      brand,
      organisationLogo: "org-logo.png",
      property: property({
        logo: "westlands.png",
        address: "Westlands Road",
        phone: "+254711111111",
        email: "westlands@example.com",
      }),
    });
    expect(id.logo).toBe("westlands.png");
    expect(id.logoSource).toBe("property");
    expect(id.tradingName).toBe("Savannah Crown Westlands");
    expect(id.propertyAddress).toBe("Westlands Road");
    expect(id.propertyPhone).toBe("+254711111111");
    expect(id.propertyEmail).toBe("westlands@example.com");
    expect(id.propertyId).toBe("prop-1");
  });

  it("mixes levels field-by-field — property name with organisation contact", () => {
    const id = resolveDocumentIdentity({
      organization,
      contact,
      brand,
      organisationLogo: "org-logo.png",
      property: property({ logo: "", address: "", phone: "", email: "" }),
    });
    expect(id.logo).toBe("org-logo.png");
    expect(id.tradingName).toBe("Savannah Crown Westlands");
    expect(id.propertyAddress).toBe("Head office, Nairobi");
  });

  it("always keeps the registered legal entity at organisation level", () => {
    const id = resolveDocumentIdentity({
      organization,
      contact,
      brand,
      property: property({ name: "Savannah Crown Diani" }),
    });
    expect(id.legalName).toBe("Savannah Crown Limited");
    expect(id.tradingName).toBe("Savannah Crown Diani");
  });

  it("degrades to organisation rather than borrowing another property's mark", () => {
    // An unresolved active property id must never resolve to a sibling branch.
    const id = resolveDocumentIdentity({
      organization,
      contact,
      brand,
      organisationLogo: "org-logo.png",
      property: null,
    });
    expect(id.logo).toBe("org-logo.png");
    expect(id.propertyName).toBe("");
  });
});

describe("state system — no raw database internals reach the user", () => {
  const raw = [
    'column event_bookings.guest_count does not exist',
    'relation "public.neo_facts" does not exist',
    'PGRST116: JSON object requested, multiple (or no) rows returned',
    'new row violates row-level security policy for table "folios"',
    'duplicate key value violates unique constraint "user_roles_pkey"',
  ];

  it.each(raw)("sanitises %s", (message) => {
    const safe = sanitizeErrorMessage(new Error(message));
    expect(safe).not.toMatch(/does not exist|row-level security|PGRST|constraint|relation |column /i);
    expect(safe.length).toBeGreaterThan(0);
  });

  it("keeps a plain, human-written message intact", () => {
    expect(sanitizeErrorMessage(new Error("Select a property to continue."))).toBe(
      "Select a property to continue.",
    );
  });
});

describe("shared state language is used by module shells", () => {
  const shells = [
    "src/components/pms/PmsShared.tsx",
    "src/components/analytics/AnalyticsShared.tsx",
    "src/components/marketing/MarketingShared.tsx",
    "src/components/platform/PlatformShared.tsx",
    "src/components/events/EventsShared.tsx",
    "src/components/dashboard/AwaitingData.tsx",
  ];

  it.each(shells)("%s re-exports the shared states instead of forking them", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("@/components/common/StateSystem");
  });
});

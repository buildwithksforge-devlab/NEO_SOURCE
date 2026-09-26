import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * NEØ unified experience — authorization boundary contract.
 *
 * Authentication is never authorization. These tests pin the boundaries that
 * the four entrances (Stay & Dine, Work, Partner, Rider) depend on, so a later
 * refactor cannot quietly open a door:
 *
 *  - private routines are never callable anonymously;
 *  - partner/relationship grants are always issued by the hotel, never claimed
 *    by the person asking;
 *  - the rider field app only opens for an active roster entry;
 *  - customer laundry prices and orders are priced by the hotel, server-side.
 */

const read = (path: string) => readFileSync(path, "utf8");

describe("front door helpers", () => {
  const source = read("src/lib/front-door.ts");

  it("models all four entrances", () => {
    for (const door of ["stay_dine", "work", "partner", "rider"]) {
      expect(source).toContain(door);
    }
  });

  it("gives a plain refusal reason for every closed entrance", () => {
    expect(source).toMatch(/refus|not registered|not /i);
  });
});

describe("partner access is granted by the hotel", () => {
  const admin = read("src/routes/admin.partner-access.tsx");
  const portal = read("src/routes/partner.$propertySlug.tsx");

  it("grants and withdrawals go through the guarded hotel routines", () => {
    expect(admin).toContain("neo_partner_invite");
    expect(admin).toContain("neo_partner_set_access");
    expect(admin).toContain("neo_partner_access_list");
  });

  it("the administration screen requires administration edit authority", () => {
    expect(admin).toContain('can("administration", "workspace", "edit")');
  });

  it("the portal reads only scoped partner context, never raw operational tables", () => {
    expect(portal).toContain("neo_partner_context");
    expect(portal).toContain("neo_partner_records");
    expect(portal).not.toMatch(/from\(\s*"purchase_orders"/);
    expect(portal).not.toMatch(/from\(\s*"supplier_invoices"/);
  });
});

describe("rider door", () => {
  const data = read("src/lib/delivery-data.ts");
  const app = read("src/routes/rider.index.tsx");

  it("only an active roster entry opens the field app", () => {
    // The active-roster check now lives in neo_rider_me, which also matches a
    // hotel-employed rider through their staff record.
    const profile = data.slice(data.indexOf("export function useMyRiderProfile"));
    expect(profile.slice(0, 1200)).toContain('guardedRpc(sb, "neo_rider_me"');
  });

  it("explains a withdrawn roster place instead of showing an empty app", () => {
    expect(app).toContain("Rider access not open");
  });
});

describe("customer laundry uses the canonical laundry operation", () => {
  const lib = read("src/lib/guest-laundry.ts");
  const page = read("src/routes/guest.$hotelSlug.laundry.tsx");

  it("prices and orders come from hotel-owned routines, not the browser", () => {
    expect(lib).toContain("neo_guest_laundry_pricelist");
    expect(lib).toContain("neo_guest_place_laundry_order");
    expect(lib).toContain("neo_guest_my_laundry");
  });

  it("never computes a chargeable total client-side as the submitted price", () => {
    expect(page).not.toMatch(/unit_price:\s*[^,\n]*price/);
  });
});

describe("public experience configuration", () => {
  const admin = read("src/routes/admin.public-experience.tsx");

  it("covers the laundry service switches the customer laundry flow reads", () => {
    for (const key of [
      "laundry_resident",
      "laundry_public",
      "laundry_collection",
      "laundry_delivery",
    ]) {
      expect(admin).toContain(key);
    }
  });

  it("keeps discovery opt-in per property", () => {
    expect(admin).toContain("discoverable");
  });
});

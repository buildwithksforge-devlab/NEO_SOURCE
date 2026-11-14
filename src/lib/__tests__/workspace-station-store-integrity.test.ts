import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261105180000_workspace_station_store_integrity.sql",
  "utf8",
);

const kitchenData = readFileSync(
  "src/lib/kitchen-data.ts",
  "utf8",
);

const canonicalClient = readFileSync(
  "src/lib/station-store-routing.ts",
  "utf8",
);

const menuConsumption = readFileSync(
  "src/components/pos/MenuConsumptionCard.tsx",
  "utf8",
);

const kitchenSettings = readFileSync(
  "src/routes/_shell.kitchen.settings.tsx",
  "utf8",
);

describe("generic workspace station-store integrity", () => {
  it("contains no customer-specific identifiers", () => {
    for (const forbidden of [
      "Savanna Crown",
      "Mawimbi",
      "SCN ",
      "2addbd01-c643-406a-bd7d-fac1aa76b23c",
      "4089c5bd-d136-569a-88ad-ff07df20794a",
      "732adf15-c3a4-5f61-8686-15c9ab5cece3",
    ]) {
      expect(migration).not.toContain(forbidden);
    }
  });

  it("rejects unsafe mappings in every workspace", () => {
    expect(migration).toContain(
      "station_consumption_stores_integrity",
    );
    expect(migration).toContain(
      "station and store belong to different workspaces",
    );
    expect(migration).toContain(
      "station and store belong to different properties",
    );
    expect(migration).toContain(
      "consumption store is inactive",
    );
    expect(migration).toContain(
      "Main Store supplies departments through requisitions",
    );
  });

  it("resolves only explicit departmental stores", () => {
    expect(migration).toContain(
      "NOT COALESCE(sl.is_main, false)",
    );
    expect(migration).toContain(
      "sl.branch_id IS NOT DISTINCT FROM s.branch_id",
    );
    expect(migration).toContain(
      "m.branch_id IS NOT DISTINCT FROM s.branch_id",
    );
  });

  it("uses validated RPCs for frontend writes", () => {
    expect(kitchenData).toContain(
      '"neo_station_store_set"',
    );
    expect(kitchenData).not.toContain(
      '.from("station_consumption_stores").upsert',
    );
    expect(canonicalClient).toContain(
      '"neo_station_store_set"',
    );
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE",
    );
  });

  it("does not expose menu-level store overrides", () => {
    expect(menuConsumption).not.toContain(
      "issuing_location_id",
    );
    expect(menuConsumption).not.toContain(
      "issuing_location_name",
    );
    expect(menuConsumption).not.toContain(
      "useStockLocations",
    );
    expect(menuConsumption).toContain(
      "departmental store mapped to this item",
    );
    expect(menuConsumption).toContain(
      "Menu items cannot override",
    );
  });

  it("keeps physical store setup explicit and fail-closed", () => {
    expect(kitchenSettings).toContain(
      "No store — items sent here are blocked",
    );
    expect(kitchenSettings).toContain(
      "Assign store",
    );
    expect(kitchenSettings).toContain(
      "Cannot post stock",
    );
    expect(migration).toContain(
      "nothing is selected automatically",
    );
    expect(migration).toContain(
      "No existing mapping is silently rewritten here",
    );
  });
});

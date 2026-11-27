import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("functional closure source contracts", () => {
  it("creates newly selected POS items in draft status", () => {
    const source = read("src/lib/pos-data.ts");
    const start = source.indexOf("export function useAddOrderItem()");
    const end = source.indexOf("export function useRemoveDraftItem()");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('status: "draft"');
  });

  it("does not report unresolved production dispatch as successful", () => {
    const source = read("src/lib/pos-data.ts");
    expect(source).toContain('saved["unassigned_station"] !== 0');
  });

  it("requires the installed canonical duplicate production safeguard", () => {
    const source = read(
      "supabase/migrations/20261125211000_pos_dispatch_integrity.sql"
    );

    expect(source).toContain("pg_get_functiondef");
    expect(source).toContain("RAISE EXCEPTION");
    expect(source).toContain("neo_active_primary_ticket_guard_v1");
    expect(source).toContain("NEO_PRODUCTION_DUPLICATE_CONFLICT");
  });

  it("requires canonical primary and secondary routing safeguards", () => {
    const source = read(
      "supabase/migrations/20261125211000_pos_dispatch_integrity.sql"
    );

    expect(source).toContain("pg_get_functiondef");
    expect(source).toContain("RAISE EXCEPTION");
    expect(source).toContain("neo_active_primary_ticket_guard_v1");
    expect(source).toContain("neo_pos_route_captured_secondary_tickets");
  });

  it("registers opening volume without opening sealed stock", () => {
    const source = read(
      "supabase/migrations/20261125210000_open_container_opening_stock.sql"
    );

    expect(source).toContain("'sealed_stock_deducted',false");
    expect(source).not.toContain(
      "PERFORM public.inventory_open_container"
    );
  });

  it("uses a unique immutable path for each avatar upload", () => {
    const source = read("src/lib/avatars.ts");

    expect(source).toContain("crypto.randomUUID()");
    expect(source).toContain("upsert: false");
    expect(source).toContain("await supabase.auth.getUser()");
  });

  it("refreshes signed avatar URLs before expiry", () => {
    const source = read("src/lib/avatars.ts");

    expect(source).toContain(
      "refetchInterval: 25 * 60 * 1000"
    );

    expect(source).toContain("refetchOnReconnect: true");
  });

  it("preserves combined station selection on actionable displays", () => {
    const source = read(
      "src/components/kitchen/ProductionDisplay.tsx"
    );

    expect(source).toContain("permittedPairStationIds");
    expect(source).toContain("selectedPairStations");
    expect(source).toContain("setPairStationIds");
  });
});
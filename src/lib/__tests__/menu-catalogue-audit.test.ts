import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const SQL = read("src/lib/__tests__/fixtures/pos-settlement-menu.sql");
const menuPage = read("src/routes/_shell.pos.menu.tsx");
const terminal = read("src/routes/_shell.pos.orders.$id.tsx");
const posData = read("src/lib/pos-data.ts");

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const catalogue = fn("neo_menu_catalogue");
const assign = fn("neo_menu_assign_station");

describe("canonical menu catalogue", () => {
  it("returns import provenance for every row", () => {
    for (const col of [
      "imported boolean",
      "import_batch_id uuid",
      "import_file_name text",
      "import_batch_status text",
    ]) {
      expect(catalogue).toContain(col);
    }
    expect(catalogue).toContain("menu_import_batches");
  });

  it("returns the effective station and where the routing came from", () => {
    expect(catalogue).toContain("neo_kitchen_resolve_station");
    expect(catalogue).toContain("station_source text");
    expect(catalogue).toContain("station_missing boolean");
    expect(catalogue).toContain("assigned_station_id uuid");
  });

  it("is strictly scoped to the organisation and the caller's properties", () => {
    expect(catalogue).toContain("mi.organization_id = _org");
    expect(catalogue).toContain("public.neo_branch_in_scope(mi.branch_id)");
    expect(catalogue).toContain("has_permission('pos','menu','view')");
  });

  it("publishes only published rows unless drafts are explicitly requested", () => {
    expect(catalogue).toContain("(_include_drafts OR mi.publish_status = 'published')");
    expect(catalogue).toContain("_include_drafts boolean DEFAULT false");
  });

  it("is registered and not callable anonymously", () => {
    expect(RPC_MANIFEST["neo_menu_catalogue"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_menu_assign_station"]).toBe("authenticated");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.neo_menu_catalogue(uuid,boolean) FROM PUBLIC, anon;");
  });
});

describe("station assignment authority", () => {
  it("requires the canonical assign-station capability, not broad menu management", () => {
    expect(assign).toContain("has_permission('pos','menu','assign-station')");
    expect(assign).not.toContain("'menu.manage'");
  });

  it("denies assignment across properties and validates the station", () => {
    expect(assign).toContain("neo_branch_in_scope(_item.branch_id)");
    expect(assign).toContain("property outside your access");
    expect(assign).toContain("neo_station_is_usable");
  });

  it("records who changed the routing", () => {
    expect(assign).toContain("pos.menu.assign_station");
    expect(assign).toContain("audit_logs");
  });
});

describe("menu surfaces", () => {
  it("Menu Management reads the catalogue with drafts and shows provenance", () => {
    expect(menuPage).toContain("useMenuCatalogue(true)");
    expect(menuPage).toContain(">Imported<");
    expect(menuPage).toContain("import_file_name");
    expect(menuPage).toContain("import_batch_status");
  });

  it("Menu Management exposes menu, category, routing, publish and import narrowing", () => {
    // Category selection is the catalogue rail; routing gaps are a summary lens.
    expect(menuPage).toContain('title="Categories"');
    expect(menuPage).toContain("setCategoryRail");
    expect(menuPage).toContain('toggleLens("routing")');
    for (const label of [
      'aria-label="Filter by publish status"',
      'aria-label="Filter by origin"',
      'aria-label="Filter by menu"',
      'aria-label="Filter by availability"',
      'aria-label="Filter by routing source"',
      'aria-label="Filter by import batch"',
    ]) {
      expect(menuPage).toContain(label);
    }
  });

  it("counts published, draft, imported and unrouted items from the same scoped source", () => {
    expect(menuPage).toContain('label: "Sellable now"');
    expect(menuPage).toContain('label: "Drafts"');
    expect(menuPage).toContain('label: "Missing routing"');
    expect(menuPage).toContain("r.imported");
    expect(menuPage).toContain("r.station_missing");
  });

  it("gates the inline assignment control on the canonical capability", () => {
    expect(menuPage).toContain('can("pos", "menu.edit")');
    expect(menuPage).toContain("{canAssignStation ? (");
  });

  it("the ordering terminal sells only published catalogue rows, scoped to the order's property", () => {
    // The terminal reads the catalogue of the property the order belongs to,
    // not the property selected in the shell, so one screen can never show
    // another property's duplicate products or prices.
    expect(terminal).toContain("useMenuCatalogue(false, order.data?.branch_id ?? null)");
    expect(terminal).not.toContain("useMenuItems");
    expect(posData).toContain(
      "export function useMenuCatalogue(includeDrafts = false, branchOverride?: string | null)",
    );
  });

  it("refuses to send a line that has no production station", () => {
    // A bill must never read Sent while the kitchen received nothing.
    expect(terminal).toContain("const unroutable = unsent.filter((l) => !l.station_id);");
    expect(terminal).toContain("unroutable.length > 0");
    expect(terminal).toContain("m.station_missing");
  });
});

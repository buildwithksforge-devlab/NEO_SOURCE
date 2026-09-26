/**
 * Supply chain master data and RFQ contract.
 *
 * Phase 1C closed three gaps that made the chain incoherent:
 *   • stock items could only be created by a migration, so operators faked a
 *     receipt to bring an item into existence;
 *   • reorder levels could only express a minimum, not a reorder point and a
 *     target to buy back up to;
 *   • the RFQ tables existed but nothing raised an RFQ, and there was no honest
 *     record of whether a supplier had actually been contacted.
 *
 * These assertions read the shipped source so the surfaces cannot quietly
 * regress to the earlier state.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RFQ_DISPATCH_STATES } from "@/lib/procurement-department";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// The stock item master lives on the Inventory "Items, Groups & Stores" screen.
const suppliersRoute = read("src/routes/_shell.inventory.items.tsx");
const inventoryIndex = read("src/routes/_shell.inventory.index.tsx");
const configCollection = read("src/components/config/ConfigCollection.tsx");
const procurementDepartment = read("src/lib/procurement-department.ts");
const quotationsRoute = read("src/routes/_shell.procurement.quotations.tsx");

describe("stock item master", () => {
  it("has a catalogue that creates stock items directly", () => {
    expect(suppliersRoute).toContain('table="stock_items"');
    expect(suppliersRoute).toContain('singular="Stock item"');
  });

  it("captures the identifying, unit and control fields an item needs", () => {
    for (const field of [
      '"sku"',
      '"category_id"',
      '"base_unit"',
      '"purchase_unit"',
      '"purchase_to_base"',
      '"min_level"',
      '"reorder_point"',
      '"par_level"',
      '"preferred_supplier_id"',
      '"default_location_id"',
      '"track_batches"',
      '"track_expiry"',
      '"active"',
    ]) {
      expect(suppliersRoute, `stock item field ${field} missing`).toContain(`name: ${field}`);
    }
  });

  it("points at the real category, supplier and store records rather than typed names", () => {
    expect(suppliersRoute).toContain(`table: "stock_categories"`);
    expect(suppliersRoute).toContain('lookup: { table: "suppliers"');
    expect(suppliersRoute).toContain('lookup: { table: "stock_locations" }');
    expect(configCollection).toContain("config-collection-lookups");
  });

  it("does not create a second inventory master — it edits the canonical table", () => {
    expect(suppliersRoute).not.toContain("inventory_items");
    expect(suppliersRoute).not.toContain("stock_item_master");
  });

  it("is reachable from the inventory overview instead of through a fake receipt", () => {
    expect(inventoryIndex).toContain("Stock items");
    expect(inventoryIndex).toContain('to="/inventory/items"');
  });

  it("keeps stock separate from the asset register", () => {
    expect(suppliersRoute).toContain("asset register");
  });
});

describe("requests for quotation", () => {
  it("raises an RFQ against a purchase request and invites suppliers", () => {
    expect(procurementDepartment).toContain("export function useCreateRfq");
    expect(procurementDepartment).toContain('.from("rfqs")');
    expect(procurementDepartment).toContain('.from("rfq_suppliers")');
    expect(procurementDepartment).toContain("Invite at least one supplier");
  });

  it("never claims a supplier was contacted without a real despatch", () => {
    expect(Object.keys(RFQ_DISPATCH_STATES)).toEqual([
      "prepared",
      "ready-to-send",
      "downloaded",
      "marked-sent",
      "sent",
    ]);
    expect(procurementDepartment).toContain("export function useRecordRfqDispatch");
    expect(procurementDepartment).toContain("nothing is sent until you despatch it");
  });

  it("a new invitation starts prepared, not sent", () => {
    expect(procurementDepartment).toContain('dispatch_state: "prepared"');
  });

  it("surfaces the RFQ on the quotation comparison screen behind the management capability", () => {
    expect(quotationsRoute).toContain("RfqPanel");
    expect(quotationsRoute).toContain("mayManage ? (");
  });

  it("does not build a second procurement engine — quotations still award through the existing path", () => {
    expect(procurementDepartment).toContain("export function useSelectQuotation");
    expect(procurementDepartment).toContain("the order still follows the approval rules");
  });
});

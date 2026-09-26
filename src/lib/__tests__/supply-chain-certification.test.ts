/**
 * Stage 1C certification hardening.
 *
 * Covers the honest RFQ provider state, draft purchase request de-duplication,
 * the Lost & Found custody audit trail read, the insufficient-stock
 * reconciliation view, and the Housekeeper supply-request escalation contract.
 * These read the real source so the behaviour cannot silently regress.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { reorderQuantityFor } from "@/lib/inventory-data";

const src = (p: string) => readFileSync(resolve(process.cwd(), "src", p), "utf8");

describe("RFQ despatch is honest about outbound providers", () => {
  const rfq = src("routes/_shell.procurement.quotations.tsx");

  it("reads the canonical provider connections rather than inventing a provider", () => {
    expect(rfq).toContain("useProviderConnections");
    expect(rfq).toMatch(/noProvider\s*=\s*!providers\.isLoading/);
  });

  it("shows an explicit no-provider state with a manual next step", () => {
    expect(rfq).toContain("rfq-no-provider");
    expect(rfq).toContain("Provider not configured");
    expect(rfq).toMatch(/record the despatch/i);
  });

  it("does not block RFQ generation or manual despatch recording on the provider", () => {
    expect(rfq).toContain("rfq-no-provider");
    // The state is informational only: nothing is disabled or hidden because
    // of it, so the operator can still generate and manually mark sent.
    expect(rfq).not.toMatch(/disabled=\{\s*noProvider/);
    expect(rfq).not.toMatch(/noProvider\s*\?[^:]*null/);
  });
});

describe("reorder -> draft purchase request cannot silently duplicate", () => {
  const inv = src("lib/inventory-data.ts");

  it("delegates de-duplication to the atomic canonical function", () => {
    expect(inv).toContain("neo_purchase_request_from_reorder");
    expect(inv).toMatch(/result\["duplicate"\]/);
  });

  it("surfaces the existing draft instead of creating a second one", () => {
    expect(inv).toContain("A draft purchase request already exists for this item");
  });
});

describe("Lost & Found custody audit trail", () => {
  const data = src("lib/operations-data.ts");
  const page = src("routes/_shell.housekeeping.lost-found.tsx");

  it("reads the canonical trigger-written history table", () => {
    expect(data).toContain("useLostFoundHistory");
    expect(data).toContain("lost_found_custody_history");
    expect(data).toMatch(/previous_status, new_status, previous_custodian, new_custodian/);
    expect(data).toContain("performed_by");
  });

  it("does not write a parallel log from the client", () => {
    expect(data).not.toMatch(/from\("lost_found_custody_history"\)\s*\.insert/);
  });

  it("surfaces submitter, timestamps and custody changes on the manager register", () => {
    expect(page).toContain("lost-found-audit-trail");
    expect(page).toContain("useLostFoundHistory");
    expect(page).toContain("Custody audit trail");
    expect(page).toContain("Recorded by");
    expect(page).toContain("shortDateTime(entry[\"created_at\"])");
  });

  it("keeps the register behind the shared route guard", () => {
    expect(page).toContain('<OpsGuard path="/housekeeping/lost-found">');
  });
});

describe("insufficient-stock outcomes are surfaced, not hidden", () => {
  const recon = src("lib/stock-reconciliation.ts");
  const page = src("routes/_shell.kitchen.reconciliation.tsx");

  it("reads negative balances from the canonical stock levels", () => {
    expect(recon).toContain("useInsufficientStockOutcomes");
    expect(recon).toContain('from("stock_levels")');
    expect(recon).toMatch(/\.lt\("quantity_on_hand", 0\)/);
  });

  it("never posts a compensating movement", () => {
    expect(recon).not.toMatch(/rpc\(\s*"inventory_apply_movement"/);
    expect(recon).not.toMatch(/\.insert\(/);
    expect(recon).not.toMatch(/\.update\(/);
  });

  it("scopes the read to the active property", () => {
    expect(recon).toContain("useActivePropertyFilter");
    expect(recon).toMatch(/branchId/);
  });

  it("is reachable from the reconciliation surface with an honest empty state", () => {
    expect(page).toContain("InsufficientStockPanel");
    expect(page).toContain("insufficient-stock-clear");
    expect(page).toMatch(/never partially deducted/i);
  });
});

describe("Housekeeper supply need escalates to a manager request", () => {
  const myWork = src("routes/_shell.housekeeping.my-work.tsx");

  it("uses the subordinate reporting capability, not stores requisition rights", () => {
    expect(myWork).toMatch(/can\("housekeeping", "supply-need", "report"\)/);
    expect(myWork).not.toContain("stores.requisitions.create");
    expect(myWork).not.toContain("stores.requisitions.submit");
  });

  it("creates the canonical department stock need, not a stores requisition", () => {
    expect(myWork).toContain("useReportHkStockNeed");
    expect(src("lib/housekeeping-department.ts")).toContain("neo_department_stock_need_create");
    expect(myWork).not.toMatch(/from\("store_requisitions"\)\s*\.insert/);
  });
});

describe("phase 1C hardening", () => {
  const inventoryData = src("lib/inventory-data.ts");
  const stockItems = src("routes/_shell.inventory.items.tsx");
  const rfq = src("routes/_shell.procurement.quotations.tsx");
  const capabilities = src("lib/capabilities.ts");
  const pastry = src("routes/_shell.pastry.requisitions.tsx");

  it("raises the replenishment PR through one atomic canonical call", () => {
    expect(inventoryData).toContain("neo_purchase_request_from_reorder");
    // No separate header/line inserts survive: an orphan header is impossible.
    expect(inventoryData).not.toContain('.from("purchase_requests")\n        .insert(');
    expect(inventoryData).toContain("duplicate");
  });

  it("keeps the par-level replenishment quantity rule", () => {
    expect(reorderQuantityFor({ on_hand: 16, min_level: 20, par_level: 50 })).toBe(34);
  });

  it("resolves the stock catalogue through stores authority only", () => {
    expect(capabilities).not.toContain(
      '"/inventory/items": [{ module: "procurement", feature: "suppliers"',
    );
    expect(stockItems).not.toMatch(/can\("procurement", "suppliers", "edit"\)/);
    expect(stockItems).toContain('can("stores", "items", "edit")');
  });

  it("states the RFQ provider state honestly on both branches", () => {
    expect(rfq).toContain("Provider not configured");
    expect(rfq).toContain("prepared for manual sending");
    expect(rfq).toContain("Mark sent manually");
    expect(rfq).toContain("RFQ_CHANNELS");
  });

  it("gives the bakery its own canonical receipt confirmation", () => {
    expect(pastry).toContain("ConfirmReceiptButton");
    expect(pastry).toContain('can("kitchen", "pastry-requisition", "edit")');
  });
});

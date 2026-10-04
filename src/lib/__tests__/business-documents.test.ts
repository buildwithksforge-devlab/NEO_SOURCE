import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROUTES = "src/routes";

const routeFiles = readdirSync(ROUTES, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => join(ROUTES, file));

describe("branded business documents", () => {
  it("never prints the screen — every printable output goes through the branded engine", () => {
    const offenders = routeFiles.filter((file) => readFileSync(file, "utf8").includes("window.print("));
    expect(offenders).toEqual([]);
  });

  it("renders documents server-side from the canonical payload service", () => {
    const renderer = readFileSync("src/lib/document-pdf.server.ts", "utf8");
    expect(renderer).toContain("neo_document_payload");
    // Money must come from the record, never be re-derived at print time.
    expect(renderer).not.toMatch(/quantity\s*\*\s*unit_price/);
  });

  it("covers every document type the operation issues", () => {
    const button = readFileSync("src/components/common/DocumentPrintButton.tsx", "utf8");
    for (const type of [
      "pos_receipt",
      "invoice",
      "folio_statement",
      "beo",
      "purchase_order",
      "goods_receipt",
      "requisition",
    ]) {
      expect(button).toContain(type);
    }
  });

  it("wires the document button into each owning screen", () => {
    const expected: Record<string, string> = {
      "_shell.pos.orders.$id.tsx": "pos_receipt",
      "_shell.finance.receivables.tsx": "invoice",
      "_shell.pms.folios.$id.tsx": "folio_statement",
      "_shell.events.bookings.$id.tsx": "beo",
      "_shell.lpos.$id.tsx": "purchase_order",
      "_shell.inventory.receiving.tsx": "goods_receipt",
      "_shell.inventory.requisitions.tsx": "requisition",
    };
    for (const [file, type] of Object.entries(expected)) {
      const source = readFileSync(join(ROUTES, file), "utf8");
      expect(source, `${file} must issue a branded ${type}`).toContain(`type="${type}"`);
    }
  });

  it("prints the invoice already issued for an event instead of issuing a second one", () => {
    const hooks = readFileSync("src/lib/events-data.ts", "utf8");
    expect(hooks).toContain("useEventInvoices");
    expect(hooks).toContain("useEventInvoice");
    expect(hooks).toContain("event_booking_id");

    for (const file of ["_shell.events.billing.tsx", "_shell.events.bookings.$id.tsx"]) {
      const source = readFileSync(join(ROUTES, file), "utf8");
      expect(source, `${file} must offer the invoice document`).toContain('type="invoice"');
      // The action only appears when a linked invoice exists — never a dead button.
      expect(source).toMatch(/(invoiceByBooking\[r\.booking_id\]|eventInvoice\.data)\s*\?/);
    }
  });



  it("enforces scope and permission server-side, not in the button", () => {
    const fn = readFileSync("src/lib/document-pdf.functions.ts", "utf8");
    expect(fn).toContain("requireSupabaseAuth");
    expect(fn).toContain("Unknown document type.");
  });
});

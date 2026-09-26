// @vitest-environment jsdom
/**
 * The canonical NEØ print template.
 *
 * These assertions lock the approved design language onto every printable
 * output — the vector wireframe corner, the brown title block and total bar,
 * icon-led contact footer and the centred "Powered by NEØ" signature — and
 * guard the two rules that matter more than the decoration: the printed
 * numbers are the ones handed in (nothing is recalculated), and the identity
 * comes from the document's own property or its issued branding snapshot.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import { ThermalReceipt } from "@/components/documents/ThermalReceipt";
import { documentTraceCode } from "@/lib/document-trace";
import { WIREFRAME_EDGES, wireframeSegments } from "@/lib/document-artwork";

vi.mock("@/lib/branding", () => ({
  useBranding: () => ({
    branding: { logo: null },
    brand: { primary: "#18C4C8", accent: "#D5AF63", logoText: "NEØ" },
  }),
}));

vi.mock("@/lib/tenant", () => ({
  useTenant: () => ({
    tenant: {
      organization: { id: "org-1", name: "Coastline Collection", legalName: "Coastline Collection Limited" },
      contact: { address: "Head office", phonePrimary: "+254700000000", email: "hq@example.com" },
      regional: { taxIdLabel: "PIN", taxId: "P051", currency: "KES" },
      branches: [
        {
          id: "prop-1",
          name: "Coastline Diani",
          logo: null,
          address: "Diani Beach Road",
          phone: "+254711111111",
          email: "diani@example.com",
        },
      ],
    },
  }),
}));

vi.mock("@/lib/branch-filter", () => ({
  useActivePropertyFilter: () => ({ branchId: "prop-1" }),
}));

afterEach(cleanup);

const columns = [
  { key: "description", label: "Description" },
  { key: "amount", label: "Total", align: "right" as const },
];

const rows = [{ description: "Deluxe room, 2 nights", amount: "128,000.00" }];

function renderInvoice(props: Partial<React.ComponentProps<typeof DocumentPreview>> = {}) {
  return render(
    <DocumentPreview
      documentType="Invoice"
      documentNumber="INV-002210"
      columns={columns}
      rows={rows}
      addressedTo={{ title: "Invoice to:", lines: ["Wanjiru Kamau", "Nairobi"] }}
      secondParty={{ title: "Property:", lines: ["Coastline Diani"] }}
      totals={[{ label: "Sub-total", value: "110,344.83" }]}
      headline={{ label: "Total", value: "128,000.00" }}
      notes="Payment due within 14 days."
      {...props}
    />,
  );
}

describe("canonical document template", () => {
  it("draws the wireframe corner as vector art, never a flattened background", () => {
    const { container } = renderInvoice();
    const art = container.querySelector('[data-document-artwork="wireframe"]');
    expect(art?.tagName.toLowerCase()).toBe("svg");
    expect(art?.querySelectorAll("line").length).toBe(WIREFRAME_EDGES.length);
    expect(container.querySelector('[style*="background-image"]')).toBeNull();
  });

  it("prints the brown title block, the large title and the brown total bar", () => {
    const { container } = renderInvoice();
    const block = container.querySelector("[data-document-title-block]") as HTMLElement;
    const band = container.querySelector("[data-document-total-band]") as HTMLElement;
    expect(block.getAttribute("style")).toContain("--doc-brown");
    expect(band.getAttribute("style")).toContain("--doc-brown");
    expect(container.querySelector("[data-document-title]")?.textContent).toBe("Invoice");
  });

  it("closes with icon-led contacts and the centred house signature", () => {
    const { container, getByText } = renderInvoice();
    expect(container.querySelector('[data-document-icon="phone"]')).not.toBeNull();
    expect(container.querySelector('[data-document-icon="mail"]')).not.toBeNull();
    expect(container.querySelector('[data-document-icon="address"]')).not.toBeNull();
    expect(getByText("Powered by NEØ")).toBeTruthy();
  });

  it("prints supplied money verbatim — the template never recalculates", () => {
    const { container } = renderInvoice();
    expect(container.textContent).toContain("128,000.00");
    expect(container.textContent).toContain("110,344.83");
  });

  it("freezes identity to the issued branding snapshot when one is supplied", () => {
    const { container } = renderInvoice({
      brandingSnapshot: { tradingName: "Coastline Diani (as issued)", propertyPhone: "+254799999999" },
    });
    expect(container.querySelector("[data-document-trading-name]")?.textContent).toBe(
      "Coastline Diani (as issued)",
    );
    expect(container.textContent).toContain("+254799999999");
  });

  it("keeps the trace code stable across reprints and absent on unnumbered drafts", () => {
    const input = {
      organizationId: "org-1",
      propertyId: "prop-1",
      documentType: "invoice",
      documentNumber: "INV-002210",
    };
    expect(documentTraceCode(input)).toBe(documentTraceCode(input));
    expect(documentTraceCode(input)).toMatch(/^SCN-INV-002210-[0-9A-F]{4}$/);
    expect(documentTraceCode({ ...input, propertyId: "prop-2" })).not.toBe(documentTraceCode(input));
    expect(documentTraceCode({ ...input, documentNumber: "" })).toBeNull();
  });

  it("renders the thermal variant with the same numbers and no A4 furniture", () => {
    const { container } = render(
      <ThermalReceipt
        documentType="Receipt"
        documentNumber="RCT-000123"
        lines={[{ description: "Espresso", quantity: 2, amount: "600.00" }]}
        totals={[{ label: "Tax", value: "82.76" }]}
        headline={{ label: "Total", value: "600.00" }}
      />,
    );
    expect(container.textContent).toContain("600.00");
    expect(container.textContent).toContain("Powered by NEØ");
    expect(container.querySelector('[data-document-artwork="wireframe"]')).toBeNull();
    expect(container.querySelector("[data-document-trace]")?.textContent).toBe(
      documentTraceCode({
        organizationId: "org-1",
        propertyId: "prop-1",
        documentType: "Receipt",
        documentNumber: "RCT-000123",
      }),
    );
  });

  it("shares one wireframe geometry between the screen sheet and the PDF", () => {
    const a = wireframeSegments({ x: 0, y: 0, width: 100, height: 100 });
    const b = wireframeSegments({ x: 0, y: 0, width: 100, height: 100 });
    expect(a).toEqual(b);
    expect(a.length).toBe(WIREFRAME_EDGES.length);
  });
});

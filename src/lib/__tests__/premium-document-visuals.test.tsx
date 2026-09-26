// @vitest-environment jsdom
/**
 * Visual regression coverage for the shared premium document family.
 *
 * One shell renders every financial/guest document, so a single snapshot per
 * document type locks the premium layout: masthead identity, metadata block,
 * line-item rules, totals + headline band, property footer and page numbering.
 * The print/PDF safety assertions guarantee the chrome never reaches paper and
 * that totals/notes stay intact on the final sheet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DocumentPreview, type DocumentPreviewProps } from "@/components/documents/DocumentPreview";

vi.mock("@/lib/branding", () => ({
  useBranding: () => ({
    branding: { logo: "https://cdn.example.com/org-mark.png" },
    brand: { primary: "#18C4C8", accent: "#D5AF63", logoText: "NEØ" },
  }),
}));

vi.mock("@/lib/tenant", () => ({
  useTenant: () => ({
    tenant: {
      organization: { name: "Coastline Collection", legalName: "Coastline Collection Limited" },
      contact: {
        address: "Head office, Nairobi",
        phonePrimary: "+254700000000",
        email: "hq@example.com",
        website: "coastline.example",
      },
      regional: { taxIdLabel: "PIN", taxId: "P051", registrationNumber: "C-99", currency: "KES" },
      branches: [
        {
          id: "prop-1",
          name: "Coastline Diani",
          logo: "https://cdn.example.com/diani.png",
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

const money = (v: string) => `KES ${v}`;

const columns = [
  { key: "description", label: "Description" },
  { key: "qty", label: "Qty", align: "right" as const },
  { key: "amount", label: "Amount", align: "right" as const },
];

const rows = (count: number) =>
  Array.from({ length: count }).map((_, i) => ({
    description: `Line item ${i + 1}`,
    qty: String(i + 1),
    amount: money("1,000.00"),
  }));

const documents: Record<string, DocumentPreviewProps> = {
  receipt: {
    documentType: "Receipt",
    documentNumber: "RCT-000123",
    meta: [
      { label: "Issued", value: "14 May 2026" },
      { label: "Till", value: "Beach Bar" },
    ],
    columns,
    rows: rows(3),
    totals: [
      { label: "Subtotal", value: money("3,000.00") },
      { label: "VAT 16%", value: money("480.00") },
    ],
    headline: { label: "Amount paid", value: money("3,480.00") },
  },
  invoice: {
    documentType: "Invoice",
    documentNumber: "INV-002210",
    meta: [
      { label: "Issued", value: "14 May 2026" },
      { label: "Due", value: "28 May 2026" },
    ],
    addressedTo: { title: "Billed to", lines: ["Acme Travel Ltd", "PIN A00112233"] },
    columns,
    rows: rows(4),
    totals: [{ label: "Subtotal", value: money("4,000.00") }],
    headline: { label: "Amount due", value: money("4,640.00") },
    notes: "Payment terms: 14 days from issue.",
  },
  "folio statement": {
    documentType: "Folio statement",
    documentNumber: "FOL-000091",
    meta: [{ label: "Stay", value: "10 – 14 May 2026" }],
    addressedTo: { title: "Guest", lines: ["A. Mwangi", "Room 214"] },
    columns,
    rows: rows(5),
    totals: [
      { label: "Total charges", value: money("52,000.00") },
      { label: "Total payments", value: money("40,000.00") },
    ],
    headline: { label: "Balance due", value: money("12,000.00") },
  },
  quotation: {
    documentType: "Quotation",
    documentNumber: "QUO-000045",
    meta: [{ label: "Valid until", value: "30 May 2026" }],
    addressedTo: { title: "Prepared for", lines: ["Nairobi Chamber of Commerce"] },
    columns,
    rows: rows(3),
    totals: [{ label: "Subtotal", value: money("120,000.00") }],
    headline: { label: "Estimated total", value: money("139,200.00") },
    notes: "Rates are indicative until confirmed in writing.",
  },
};

describe("premium document family — visual snapshots", () => {
  it.each(Object.entries(documents))("%s keeps its premium sheet layout", (_name, props) => {
    const { container } = render(<DocumentPreview {...props} />);
    const sheet = container.querySelector("[data-document-page]");
    expect(sheet).not.toBeNull();
    expect(sheet?.outerHTML).toMatchSnapshot();
  });

  it.each(Object.keys(documents))("%s leads with the active property identity", (name) => {
    const props = documents[name]!;
    const { container } = render(<DocumentPreview {...props} />);
    const logo = container.querySelector("[data-document-logo]") as HTMLImageElement | null;
    expect(logo?.getAttribute("src")).toBe("https://cdn.example.com/diani.png");
    expect(container.querySelector("[data-document-trading-name]")?.textContent).toBe(
      "Coastline Diani",
    );
    expect(container.textContent).toContain("Coastline Collection Limited");
    expect(container.textContent).toContain("PIN: P051");
  });
});

describe("print and PDF layout safety", () => {
  it("hides the preview chrome from print and keeps the sheet on A4", () => {
    const { container } = render(<DocumentPreview {...documents["receipt"]!} />);
    expect(container.querySelector("[data-print-hide]")).not.toBeNull();
    expect(container.querySelector(".neo-doc-sheet")).not.toBeNull();
    expect(container.querySelector("[data-document-preview]")).not.toBeNull();
  });

  it("paginates long documents, repeats the header and numbers every page", () => {
    const { container } = render(
      <DocumentPreview {...documents["folio statement"]!} rows={rows(30)} rowsPerPage={12} />,
    );
    const pages = container.querySelectorAll("[data-document-page]");
    expect(pages).toHaveLength(3);
    pages.forEach((page, index) => {
      // Masthead and column header repeat on every sheet.
      expect(page.querySelector("[data-document-logo]")).not.toBeNull();
      expect(page.querySelectorAll("thead th")).toHaveLength(1 + columns.length);
      expect(page.querySelector("[data-document-page-number]")?.textContent).toBe(
        `Page ${index + 1} of 3`,
      );
    });
  });

  it("keeps totals, headline band and notes unbroken on the final sheet only", () => {
    const { container } = render(
      <DocumentPreview {...documents["invoice"]!} rows={rows(30)} rowsPerPage={12} />,
    );
    const pages = Array.from(container.querySelectorAll("[data-document-page]"));
    const bands = container.querySelectorAll("[data-document-total-band]");
    expect(bands).toHaveLength(1);
    expect(pages.at(-1)?.querySelector("[data-document-total-band]")).not.toBeNull();
    expect(pages.at(-1)?.querySelectorAll("[data-print-keep]").length).toBeGreaterThan(0);
    expect(pages[0]?.querySelector("[data-document-total-band]")).toBeNull();
  });

  it("renders an honest empty sheet instead of a bare table when there are no lines", () => {
    const { container } = render(
      <DocumentPreview {...documents["receipt"]!} rows={[]} emptyMessage="No charges posted yet." />,
    );
    expect(container.querySelectorAll("[data-document-page]")).toHaveLength(1);
    expect(container.textContent).toContain("No charges posted yet.");
  });
});

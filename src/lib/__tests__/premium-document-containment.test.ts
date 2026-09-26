import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("premium document engine", () => {
  const renderer = read("src/lib/document-pdf.server.ts");

  it("renders tenant branding and legal identity, never a placeholder", () => {
    expect(renderer).toContain('brand["logoLight"]');
    expect(renderer).toContain('identity["organisation"]');
    expect(renderer).toContain('identity["tax_id_label"]');
    expect(renderer).not.toMatch(/COMPANY NAME|YOUR LOGO|Savannah Crown/i);
  });

  it("puts the mark and trading name top-left and document metadata top-right", () => {
    expect(renderer).toContain("Client brand leads");
    expect(renderer).toContain("Document metadata block (top right)");
    expect(renderer).toContain('["Document no.", documentNumber]');
  });

  it("states the amount owed once, on the brown total band", () => {
    // No restated headline figure above the party block: the emphasised total
    // on the brand band is the single statement of the balance.
    expect(renderer).not.toContain('"BALANCE DUE"');
    expect(renderer).toContain("total.emphasis");
    expect(renderer).toContain("seenLabels");
  });

  it("keeps a summary panel, terms area and property footer", () => {
    expect(renderer).toContain("PAYMENT INFORMATION, TERMS & DETAIL");
    expect(renderer).toContain("footerContact");
  });

  it("still reads the canonical payload and never recomputes money", () => {
    expect(renderer).toContain("neo_document_payload");
    expect(renderer).not.toMatch(/quantity\s*\*\s*unit_price/);
  });
});

describe("containment and no-ugly-wrapping contract", () => {
  const css = read("src/styles.css");

  it("exposes atomic, single-line, row-action and document utilities", () => {
    for (const utility of [
      "@utility neo-atomic",
      "@utility neo-line-1",
      "@utility neo-line-2",
      "@utility neo-row-actions",
      "@utility neo-list-rows",
      "@utility neo-doc-frame",
      "@utility neo-doc-sheet",
    ]) {
      expect(css).toContain(utility);
    }
  });

  it("keeps atomic values on one line and row actions inside the row", () => {
    expect(css).toMatch(/@utility neo-atomic \{[\s\S]*?white-space: nowrap;/);
    expect(css).toMatch(/@utility neo-row-actions \{[\s\S]*?flex-wrap: nowrap;/);
  });

  it("ships print-safe rules: A4 page, repeated headers, no broken totals", () => {
    expect(css).toContain("@media print");
    expect(css).toContain("size: A4");
    expect(css).toContain("display: table-header-group");
    expect(css).toContain("break-inside: avoid");
  });

  it("shared cards keep short titles on one line with the full label available", () => {
    const display = read("src/components/common/DataDisplay.tsx");
    for (const primitive of ["RecordTitle", "Atomic", "RowActions"]) {
      expect(display).toContain(`export function ${primitive}`);
    }
    expect(display).toContain('className="neo-line-1 text-[0.68rem]');
    expect(display).toContain("title={label}");
    expect(display).toContain("title={title}");
    expect(read("src/components/common/FactCard.tsx")).toContain("title={fact.label}");
  });
});

describe("folio detail experience", () => {
  const page = read("src/routes/_shell.pms.folios.$id.tsx");

  it("mirrors the premium folio statement in its summary head", () => {
    expect(page).toContain("Statement head");
    expect(page).toContain("Net charges");
    expect(page).toContain("Gross billed");
    expect(page).toContain("Collected");
    expect(page).toContain("Refunds");
    expect(page).toContain("Outstanding");
  });

  it("routes printing through the unified folio statement template", () => {
    expect(page).toContain('type="folio_statement"');
  });

  it("keeps the ledger contained with a sticky identifier column", () => {
    expect(page).toContain("<TableScroll>");
    expect(page).toContain("neo-sticky-col");
    expect(page).toContain("RowActions");
    expect(page).toContain("<Atomic>");
  });
});

describe("PMS record rows stay recognisable as one record", () => {
  const board = read("src/components/pms/MovementBoard.tsx");

  it("contains the row, pins the confirmation and never stacks actions", () => {
    expect(board).toContain("<TableScroll>");
    expect(board).toContain("neo-sticky-col");
    expect(board).toContain("RowActions");
    expect(board).not.toContain('flex flex-wrap justify-end gap-2');
  });

  it("keeps money and guest identity atomic", () => {
    expect(board).toContain("<Atomic>");
    expect(board).toContain("neo-line-1");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("print UI routing", () => {
  const button = source(
    "src/components/common/SendToPrinterButton.tsx",
  );

  const order = source(
    "src/routes/_shell.pos.orders.$id.tsx",
  );

  it("filters printers by property and compatible role", () => {
    expect(button).toContain(
      "candidate.branch_id === branchId",
    );

    expect(button).toContain(
      "roleMatches(candidate, role)",
    );

    expect(button).toContain(
      '["restaurant", "receipt", "pos"]',
    );
  });

  it("passes the POS order property to both receipt actions", () => {
    const receiptActions = order.match(/<SendToPrinterButton\b[\s\S]*?\/>/g) ?? [];
    expect(receiptActions).toHaveLength(2);
    for (const action of receiptActions) {
      expect(action).toContain('type="pos_receipt"');
      expect(action).toContain('branchId={data.branch_id}');
    }
  });

  it("does not allow the browser to confirm physical outcomes", () => {
    expect(button).not.toContain(
      "useRecordPrintResult",
    );

    expect(button).not.toContain(
      "It printed",
    );

    expect(button).not.toContain(
      "It did not print",
    );
  });

  it("does not fall back to an incompatible organisation printer", () => {
    expect(button).not.toContain(
      "available.find",
    );

    expect(button).toContain(
      "No active printer matches this property and printer role",
    );
  });

  it("uses the canonical property-scoped station catalogue", () => {
    const printing = source(
      "src/lib/printing.ts",
    );

    expect(printing).toContain(
      "useScopedStations",
    );

    expect(printing).not.toContain(
      '.from("operational_stations")',
    );
  });
});

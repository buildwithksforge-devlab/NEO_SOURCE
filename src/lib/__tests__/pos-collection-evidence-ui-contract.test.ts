import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const data = readFileSync(
  "src/lib/pos-data.ts",
  "utf8",
);

const report = readFileSync(
  "src/routes/_shell.pos.reports.tsx",
  "utf8",
);

const component = readFileSync(
  "src/components/pos/PosCollectionEvidenceCard.tsx",
  "utf8",
);

describe("NEO cashier collection evidence UI", () => {
  it("keeps the existing POS reporting permission", () => {
    expect(report).toContain(
      '<PosGuard action="reports.view" path="/pos/reports">',
    );
  });

  it("uses the PostgreSQL collection evidence function", () => {
    expect(data).toContain(
      '"neo_employee_pos_collection_evidence" as never',
    );
  });

  it("uses the selected reporting period", () => {
    expect(report).toContain(
      "<PosCollectionEvidenceCard from={from} to={to} />",
    );
  });

  it("keeps collections and refunds separate", () => {
    expect(component).toContain(
      "Confirmed POS collections",
    );
    expect(component).toContain(
      "Processed refund evidence",
    );
    expect(component).not.toContain(
      "Net revenue",
    );
  });

  it("does not modify POS payments through the hook", () => {
    const hook = data.split(
      "export function usePosCollectionEvidence(",
    )[1]?.split(
      "export function useTeamPosPerformance(",
    )[0];

    expect(hook).toBeDefined();
    expect(hook).toContain("supabase.rpc(");
    expect(hook).not.toContain(".insert(");
    expect(hook).not.toContain(".update(");
    expect(hook).not.toContain(".delete(");
  });
});

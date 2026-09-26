import { describe, expect, it } from "vitest";
import { POS_KDS_LABELS, shapeReconciliationReport } from "@/lib/ops-reconciliation";

describe("reconciliation confidence", () => {
  it("never reports healthy when the check did not complete", () => {
    const report = shapeReconciliationReport({ ok: false, healthy: true }, POS_KDS_LABELS);
    expect(report.healthy).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("never reports healthy while exception rows exist", () => {
    const report = shapeReconciliationReport(
      { ok: true, healthy: true, missing_tickets: [{ id: "a" }] },
      POS_KDS_LABELS,
    );
    expect(report.total).toBe(1);
    expect(report.healthy).toBe(false);
  });

  it("reports healthy only on a completed, clean check", () => {
    const report = shapeReconciliationReport({ ok: true, healthy: true }, POS_KDS_LABELS);
    expect(report.healthy).toBe(true);
  });

  it("preserves unknown issue groups instead of reporting a false clear", () => {
    const report = shapeReconciliationReport(
      { ok: true, healthy: true, stale_open_cleaning_tasks: [{ id: "stale" }] },
      POS_KDS_LABELS,
    );
    expect(report.groups.some((group) => group.key === "stale_open_cleaning_tasks")).toBe(true);
    expect(report.total).toBe(1);
    expect(report.healthy).toBe(false);
  });
});

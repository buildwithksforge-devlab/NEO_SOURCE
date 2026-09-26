import { describe, expect, it } from "vitest";
import {
  healthDisplay,
  metricDisplay,
  reconcileContracts,
  type ReadModelContract,
} from "@/lib/dashboard-reconciliation";

const card: ReadModelContract = {
  metric: "housekeeping.rooms.to_clean",
  workspace: "/housekeeping/assignments",
  propertyScope: "property",
  dateScope: "business-date",
  lifecycle: ["dirty", "assigned"],
};

describe("card and workspace must ask the same question", () => {
  it("agrees when scope, date and lifecycle match, regardless of order", () => {
    expect(reconcileContracts(card, { ...card, lifecycle: ["Assigned", "Dirty"] })).toEqual([]);
  });

  it("catches an organisation-wide card behind a property-scoped page", () => {
    const drift = reconcileContracts({ ...card, propertyScope: "organisation" }, card);
    expect(drift).toEqual([{ field: "propertyScope", card: "organisation", workspace: "property" }]);
  });

  it("catches a different lifecycle definition", () => {
    const drift = reconcileContracts(card, { ...card, lifecycle: ["dirty"] });
    expect(drift.map((d) => d.field)).toEqual(["lifecycle"]);
  });

  it("catches a hidden extra filter on one side only", () => {
    const drift = reconcileContracts(card, { ...card, filter: "assigned_to=me" });
    expect(drift).toEqual([{ field: "filter", card: "—", workspace: "assigned_to=me" }]);
  });
});

describe("a dashboard may not invent a zero", () => {
  it("shows loading until the query settles", () => {
    expect(metricDisplay({ settled: false }).kind).toBe("loading");
    expect(metricDisplay({ settled: true, value: null }).kind).toBe("loading");
  });

  it("shows unavailable rather than zero on failure", () => {
    const d = metricDisplay({ settled: true, value: 0, error: new Error("permission denied") });
    expect(d.kind).toBe("error");
    if (d.kind === "error") expect(d.detail).toContain("permission denied");
  });

  it("shows a real zero once settled", () => {
    expect(metricDisplay({ settled: true, value: 0 })).toMatchObject({ kind: "value", value: 0 });
  });
});

describe("green requires a completed check with no exceptions", () => {
  it("is unknown before the check runs or when it fails", () => {
    expect(healthDisplay({ checked: false, exceptions: 0 }).tone).toBe("unknown");
    expect(healthDisplay({ checked: true, exceptions: 0, error: new Error("timeout") }).tone).toBe("unknown");
  });

  it("is attention while any canonical exception exists", () => {
    expect(healthDisplay({ checked: true, exceptions: 1 })).toMatchObject({ tone: "attention", label: "1 exception" });
  });

  it("is clear only after a completed, empty check", () => {
    expect(healthDisplay({ checked: true, exceptions: 0 }).tone).toBe("clear");
  });
});

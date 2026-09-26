/**
 * A request must look and behave the same wherever it is seen — Stores,
 * Procurement or Delivery. Only the actions differ, and they differ because
 * the composing route passes permission-gated action renderers, never because
 * the route decided to draw a request differently.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROUTES = [
  "src/routes/_shell.inventory.requisitions.tsx",
  "src/routes/_shell.inventory.issues.tsx",
  "src/routes/_shell.procurement.requests.tsx",
  "src/routes/_shell.delivery.requisitions.tsx",
];

const read = (p: string) => readFileSync(p, "utf8");
const primitive = read("src/components/common/RequisitionWorkspace.tsx");

describe("shared requisition workspace", () => {
  it("is used by every surface that shows a request", () => {
    for (const route of ROUTES) {
      const src = read(route);
      expect(src, `${route} does not compose the shared workspace`).toContain(
        "RequisitionWorkspace",
      );
      expect(src).toContain("@/components/common/RequisitionWorkspace");
    }
  });

  it("no surface hand-rolls its own request table instead", () => {
    for (const route of ROUTES) {
      const src = read(route);
      expect(src, `${route} still renders a bare request table`).not.toContain(
        "@/components/ui/table",
      );
    }
  });

  it("keeps the primitive presentational — no fetching, no lifecycle rules", () => {
    expect(primitive).not.toContain("supabase");
    expect(primitive).not.toContain("useQuery");
    expect(primitive).not.toContain("useMutation");
    expect(primitive).not.toContain("nav-permissions");
  });

  it("derives available actions from caller props, not route identity", () => {
    // The primitive renders whatever action nodes it is given; it must not
    // branch on which module is showing the request.
    for (const token of ["inventory", "procurement", "delivery", "stores"]) {
      expect(primitive.toLowerCase()).not.toContain(`"${token}"`);
    }
    expect(primitive).toMatch(/actions/);
  });

  it("composes the shared summary / list / inspector primitives", () => {
    expect(primitive).toContain("SummaryStrip");
    expect(primitive).toContain("InspectorSheet");
    expect(primitive).toContain("CatalogueRow");
  });
});

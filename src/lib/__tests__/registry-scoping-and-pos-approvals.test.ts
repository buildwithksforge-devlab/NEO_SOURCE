import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Departments and Stations respect the active property", () => {
  const departments = read("src/routes/_shell.departments.tsx");
  const stations = read("src/routes/_shell.stations.tsx");

  it("filters departments to the selected property plus organisation-wide rows", () => {
    expect(departments).toContain("useActivePropertyFilter");
    expect(departments).toContain("branch_id.eq.${branchId},branch_id.is.null");
  });

  it("filters the station registry, its department options and its property list", () => {
    expect(stations).toContain("useActivePropertyFilter");
    expect(stations.match(/branch_id\.eq\.\$\{branchId\},branch_id\.is\.null/g)?.length).toBe(2);
    expect(stations).toContain('query.eq("id", branchId)');
  });

  it("keys the scoped queries by the active property so switching refetches", () => {
    expect(stations).toContain('["operational-stations", organizationId, branchId ?? "all"]');
  });
});

describe("Stations can be created and fully assigned", () => {
  const stations = read("src/routes/_shell.stations.tsx");

  it("offers an admin-only create flow that writes branch and department", () => {
    expect(stations).toContain("function AddStationDialog");
    expect(stations).toContain('action: "station.created"');
    expect(stations).toContain("branch_id: branchId");
    expect(stations).toContain("department_id: departmentId");
  });

  it("requires the property/department chain before creating", () => {
    expect(stations).toContain("Choose a property and one of its departments");
    expect(stations).toContain("menuDepartmentsForBranch(departments, branchId || null)");
  });
});

describe("POS approvals gate on real approval authorities", () => {
  const approvals = read("src/routes/_shell.pos.approvals.tsx");

  it("no longer references permissions that do not exist in the catalogue", () => {
    const code = approvals.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("orders.approve");
  });

  it("gates through the single validated approval-authority helper", () => {
    expect(approvals).toContain('<PosGuard action="approvals.approve" path="/pos/approvals">');
    expect(approvals).toContain("resolvePosApprovalGates(can)");
  });
});

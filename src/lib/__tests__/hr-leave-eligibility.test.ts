import { describe, expect, it } from "vitest";
import { eligibleLeavePolicies, leaveApplicability } from "@/lib/hr-leave-eligibility";

const on = new Date("2026-06-01T00:00:00Z");

const female = {
  id: "e1",
  gender: "female",
  employment_type: "permanent",
  department_id: "d1",
  branch_id: "b1",
  employment_date: "2024-01-01",
};
const male = { ...female, id: "e2", gender: "male" };
const unrecorded = { ...female, id: "e3", gender: null };

const annual = { id: "p1", name: "Annual Leave", active: true, gender_scope: "any" };
const maternity = { id: "p2", name: "Maternity Leave", active: true, gender_scope: "female" };
const paternity = { id: "p3", name: "Paternity Leave", active: true, gender_scope: "male" };

describe("leave applicability", () => {
  it("offers unrestricted policies to everyone", () => {
    expect(leaveApplicability(female, annual, on).eligible).toBe(true);
    expect(leaveApplicability(male, annual, on).eligible).toBe(true);
  });

  it("applies statutory sex conditions both ways", () => {
    const names = eligibleLeavePolicies(female, [annual, maternity, paternity], on).map(
      (p) => p["name"],
    );
    expect(names).toEqual(["Annual Leave", "Maternity Leave"]);
    expect(
      eligibleLeavePolicies(male, [annual, maternity, paternity], on).map((p) => p["name"]),
    ).toEqual(["Annual Leave", "Paternity Leave"]);
  });

  it("does not guess when the employee record has no sex recorded", () => {
    const fit = leaveApplicability(unrecorded, maternity, on);
    expect(fit.eligible).toBe(false);
    expect(fit.reasons[0]).toContain("does not record one");
  });

  it("honours employment type, department, property and service conditions", () => {
    expect(
      leaveApplicability(female, { ...annual, employment_types: ["casual"] }, on).eligible,
    ).toBe(false);
    expect(
      leaveApplicability(female, { ...annual, department_ids: ["d9"] }, on).eligible,
    ).toBe(false);
    expect(leaveApplicability(female, { ...annual, branch_id: "b9" }, on).eligible).toBe(false);
    expect(
      leaveApplicability(
        { ...female, employment_date: "2026-05-20" },
        { ...annual, minimum_service_days: 90 },
        on,
      ).eligible,
    ).toBe(false);
  });

  it("respects the dates a policy is in force and its active flag", () => {
    expect(
      leaveApplicability(female, { ...annual, effective_from: "2026-09-01" }, on).eligible,
    ).toBe(false);
    expect(
      leaveApplicability(female, { ...annual, effective_to: "2026-01-31" }, on).eligible,
    ).toBe(false);
    expect(leaveApplicability(female, { ...annual, active: false }, on).eligible).toBe(false);
  });
});

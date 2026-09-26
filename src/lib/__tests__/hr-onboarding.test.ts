import { describe, expect, it } from "vitest";
import { onboardingProgress, onboardingRollup, onboardingStages } from "@/lib/hr-onboarding";

const complete = {
  full_name: "Lydia Chebet",
  employee_number: "STF-A-003",
  branch_id: "b1",
  department_id: "d1",
  job_title: "Finance Manager",
  employment_date: "2026-01-01",
  employment_type: "permanent",
  position_grade: "G4",
  contract_start: "2026-01-01",
  reporting_manager_id: "m1",
  payroll_status: "active",
  payroll_effective_from: "2026-01-01",
};

describe("onboarding journey", () => {
  it("is complete only when every stage's facts exist", () => {
    const stages = onboardingStages(complete, { hasPayRecord: true, hasPaymentDetails: true });
    expect(stages.every((s) => s.done)).toBe(true);
    expect(onboardingProgress(stages).percent).toBe(100);
  });

  it("names the outstanding facts per stage and never invents them", () => {
    const stages = onboardingStages(
      { ...complete, position_grade: null, contract_start: null, payroll_status: "none" },
      { hasPayRecord: false, hasPaymentDetails: false },
    );
    const terms = stages.find((s) => s.key === "terms")!;
    const payroll = stages.find((s) => s.key === "payroll")!;
    expect(terms.missing).toEqual(["Position grade", "Contract start"]);
    expect(payroll.missing).toContain("Agreed pay");
    expect(payroll.missing).toContain("Payroll enrolment");
    expect(onboardingProgress(stages).nextStage?.key).toBe("terms");
  });

  it("improves the percentage as records are filled in", () => {
    const bare = onboardingProgress(onboardingStages({ full_name: "New Starter" }));
    const partial = onboardingProgress(
      onboardingStages({ ...complete, payroll_status: "none", payroll_effective_from: null }),
    );
    expect(bare.percent).toBeLessThan(partial.percent);
    expect(partial.percent).toBeLessThan(100);
  });

  it("rolls up where each person is stuck", () => {
    const rows = [
      { stages: onboardingStages(complete, { hasPayRecord: true, hasPaymentDetails: true }) },
      { stages: onboardingStages({ ...complete, contract_start: null }) },
      { stages: onboardingStages({ full_name: "No record yet" }) },
    ];
    expect(onboardingRollup(rows)).toMatchObject({
      total: 3,
      complete: 1,
      awaitingTerms: 1,
      recordOnly: 1,
    });
  });
});

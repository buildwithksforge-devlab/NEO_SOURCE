/**
 * The HR onboarding journey.
 *
 * Three stages, in the order HR actually works: the person exists as an
 * employee record, their employment terms are established, and only then are
 * they enrolled in payroll. Each stage lists exactly which human-entered facts
 * are still outstanding — nothing here is ever guessed or auto-filled — so the
 * completion percentage moves as real records are filled in.
 *
 * Pure functions only, so the same rules are testable and every screen agrees.
 */

import type { Row } from "@/lib/hr";
import { isPayrollApproved } from "@/lib/hr-readiness";

export type OnboardingStageKey = "record" | "terms" | "payroll";

export type OnboardingStage = {
  key: OnboardingStageKey;
  label: string;
  description: string;
  /** Human-entered facts still outstanding for this stage. */
  missing: string[];
  done: boolean;
};

export type OnboardingPay = {
  /** A current pay record exists for this employee. */
  hasPayRecord: boolean;
  /** Bank / mobile money / cash payment details are on file. */
  hasPaymentDetails: boolean;
};

const present = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
};

const RECORD_FIELDS: Array<[string, string]> = [
  ["full_name", "Full name"],
  ["employee_number", "HR number"],
  ["branch_id", "Property"],
  ["department_id", "Department"],
  ["job_title", "Job title"],
];

const TERMS_FIELDS: Array<[string, string]> = [
  ["employment_date", "Employment date"],
  ["employment_type", "Employment type"],
  ["position_grade", "Position grade"],
  ["contract_start", "Contract start"],
  ["reporting_manager_id", "Reporting manager"],
];

/** The three stages for one employee, with the outstanding facts named. */
export function onboardingStages(
  employee: Row | null | undefined,
  pay: OnboardingPay = { hasPayRecord: false, hasPaymentDetails: false },
): OnboardingStage[] {
  const record = employee ?? {};

  const recordMissing = RECORD_FIELDS.filter(([field]) => !present(record[field])).map(
    ([, label]) => label,
  );
  const termsMissing = TERMS_FIELDS.filter(([field]) => !present(record[field])).map(
    ([, label]) => label,
  );

  const payrollMissing: string[] = [];
  if (!pay.hasPayRecord) payrollMissing.push("Agreed pay");
  if (!pay.hasPaymentDetails) payrollMissing.push("Payment details");
  if (!isPayrollApproved(record)) payrollMissing.push("Payroll enrolment");
  if (!present(record["payroll_effective_from"])) payrollMissing.push("Payroll effective date");

  return [
    {
      key: "record",
      label: "Employee record",
      description: "The person exists in HR with an issued number, property and department.",
      missing: recordMissing,
      done: recordMissing.length === 0,
    },
    {
      key: "terms",
      label: "Employment terms",
      description: "When they joined, on what basis, at which grade and reporting to whom.",
      missing: termsMissing,
      done: termsMissing.length === 0,
    },
    {
      key: "payroll",
      label: "Payroll enrolment",
      description: "A real agreed pay figure, how they are paid, and an enrolment date.",
      missing: payrollMissing,
      done: payrollMissing.length === 0,
    },
  ];
}

/** Share of the journey completed, counted over every tracked fact. */
export function onboardingProgress(stages: OnboardingStage[]): {
  stagesDone: number;
  outstanding: number;
  percent: number;
  nextStage: OnboardingStage | null;
} {
  const outstanding = stages.reduce((sum, s) => sum + s.missing.length, 0);
  const total = stages.reduce((sum, s) => sum + stageSize(s.key), 0);
  const percent = total === 0 ? 100 : Math.round(((total - outstanding) / total) * 100);
  return {
    stagesDone: stages.filter((s) => s.done).length,
    outstanding,
    percent: Math.max(0, Math.min(100, percent)),
    nextStage: stages.find((s) => !s.done) ?? null,
  };
}

function stageSize(key: OnboardingStageKey): number {
  if (key === "record") return RECORD_FIELDS.length;
  if (key === "terms") return TERMS_FIELDS.length;
  return 4; // agreed pay, payment details, enrolment, effective date
}

/** Organisation-level rollup for the onboarding screen's summary figures. */
export function onboardingRollup(
  rows: Array<{ stages: OnboardingStage[] }>,
): { total: number; complete: number; recordOnly: number; awaitingTerms: number; awaitingPayroll: number } {
  let complete = 0;
  let awaitingTerms = 0;
  let awaitingPayroll = 0;
  let recordOnly = 0;
  for (const row of rows) {
    const [record, terms, payroll] = row.stages;
    if (record?.done && terms?.done && payroll?.done) complete += 1;
    else if (!record?.done) recordOnly += 1;
    else if (!terms?.done) awaitingTerms += 1;
    else awaitingPayroll += 1;
  }
  return { total: rows.length, complete, recordOnly, awaitingTerms, awaitingPayroll };
}

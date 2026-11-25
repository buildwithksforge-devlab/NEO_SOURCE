/**
 * Housekeeping operational activity from existing job records.
 *
 * Counts current recorded job states, not historical
 * transitions or employee performance scores.
 */

export type HousekeepingActivityJob = {
  id: string;
  status: string | null;
  inspection_status: string | null;
  completed_at: string | null;
};

export type HousekeepingActivitySummary = {
  totalAssigned: number;
  completed: number;
  awaitingInspection: number;
  reworkJobs: number;
  completedWithTimestamp: number;
};

export function summarizeHousekeepingActivity(
  jobs: readonly HousekeepingActivityJob[],
): HousekeepingActivitySummary {
  const result: HousekeepingActivitySummary = {
    totalAssigned: 0,
    completed: 0,
    awaitingInspection: 0,
    reworkJobs: 0,
    completedWithTimestamp: 0,
  };

  for (const job of jobs) {
    result.totalAssigned++;

    const status = String(
      job.status ?? "",
    ).toLowerCase();

    const inspection = String(
      job.inspection_status ?? "",
    ).toLowerCase();

    if (status === "completed") {
      result.completed++;

      if (job.completed_at) {
        result.completedWithTimestamp++;
      }
    }

    if (
      status === "awaiting-inspection" ||
      inspection === "pending" ||
      inspection === "awaiting-inspection"
    ) {
      result.awaitingInspection++;
    }

    if (status === "rework") {
      result.reworkJobs++;
    }
  }

  return result;
}

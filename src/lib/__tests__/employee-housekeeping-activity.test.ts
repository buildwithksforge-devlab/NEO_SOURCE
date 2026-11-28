import {
  describe,
  expect,
  it,
} from "vitest";

import {
  summarizeHousekeepingActivity,
  type HousekeepingActivityJob,
} from "../employee-housekeeping-activity";

const jobs: HousekeepingActivityJob[] = [
  {
    id: "job-1",
    status: "completed",
    inspection_status: "passed",
    completed_at: "2026-11-25T08:00:00Z",
  },
  {
    id: "job-2",
    status: "awaiting-inspection",
    inspection_status: "pending",
    completed_at: null,
  },
  {
    id: "job-3",
    status: "in-progress",
    inspection_status: null,
    completed_at: null,
  },
  {
    id: "job-4",
    status: "rework",
    inspection_status: "failed",
    completed_at: null,
  },
];

describe("HR housekeeping operational activity", () => {
  it("counts assigned jobs", () => {
    expect(
      summarizeHousekeepingActivity(jobs).totalAssigned,
    ).toBe(4);
  });

  it("counts completed jobs", () => {
    expect(
      summarizeHousekeepingActivity(jobs).completed,
    ).toBe(1);
  });

  it("does not double count awaiting inspection", () => {
    expect(
      summarizeHousekeepingActivity(jobs)
        .awaitingInspection,
    ).toBe(1);
  });

  it("counts jobs currently requiring rework", () => {
    expect(
      summarizeHousekeepingActivity(jobs).reworkJobs,
    ).toBe(1);
  });

  it("counts completed jobs with timestamps", () => {
    expect(
      summarizeHousekeepingActivity(jobs)
        .completedWithTimestamp,
    ).toBe(1);
  });

  it("returns zero totals for no assignments", () => {
    expect(
      summarizeHousekeepingActivity([]),
    ).toEqual({
      totalAssigned: 0,
      completed: 0,
      awaitingInspection: 0,
      reworkJobs: 0,
      completedWithTimestamp: 0,
    });
  });

  it("does not mutate existing records", () => {
    const before = JSON.stringify(jobs);

    summarizeHousekeepingActivity(jobs);

    expect(JSON.stringify(jobs)).toBe(before);
  });

  it("keeps rework separate from completed work", () => {
    const summary = summarizeHousekeepingActivity([
      {
        id: "rework-only",
        status: "rework",
        inspection_status: "failed",
        completed_at: null,
      },
    ]);

    expect(summary.reworkJobs).toBe(1);
    expect(summary.completed).toBe(0);
  });

  it("does not count a completed job without a timestamp as timestamped", () => {
    const summary = summarizeHousekeepingActivity([
      {
        id: "completed-without-time",
        status: "completed",
        inspection_status: "passed",
        completed_at: null,
      },
    ]);

    expect(summary.completed).toBe(1);
    expect(summary.completedWithTimestamp).toBe(0);
  });
});

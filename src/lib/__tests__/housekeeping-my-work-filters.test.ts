import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterMyJobs } from "@/routes/_shell.housekeeping.my-work";

/**
 * The personal work filters are derived only from facts already on the
 * housekeeper's own assigned jobs — status, due_at, completed_at — so no
 * filter can require a department-wide read the role is not permitted.
 */
const NOW = new Date("2026-03-10T14:00:00.000Z");
const at = (iso: string) => iso;

const rows = [
  { id: "a", status: "assigned", due_at: at("2026-03-10T18:00:00.000Z"), completed_at: null },
  { id: "b", status: "assigned", due_at: at("2026-03-10T09:00:00.000Z"), completed_at: null },
  { id: "c", status: "in-progress", due_at: at("2026-03-09T09:00:00.000Z"), completed_at: null },
  {
    id: "d",
    status: "completed",
    due_at: at("2026-03-10T08:00:00.000Z"),
    completed_at: at("2026-03-10T11:30:00.000Z"),
  },
  {
    id: "e",
    status: "completed",
    due_at: at("2026-03-09T08:00:00.000Z"),
    completed_at: at("2026-03-09T12:00:00.000Z"),
  },
  { id: "f", status: "assigned", due_at: null, completed_at: null },
] as unknown as Record<string, unknown>[];

const ids = (filter: Parameters<typeof filterMyJobs>[1]) =>
  filterMyJobs(rows, filter, NOW).map((r) => String(r["id"]));

describe("my housekeeping work filters", () => {
  it("shows every open job by default and hides finished ones", () => {
    expect(ids("all")).toEqual(["a", "b", "c", "f"]);
  });

  it("lists jobs due today that are not finished", () => {
    expect(ids("due")).toEqual(["a", "b"]);
  });

  it("lists jobs whose due time has passed", () => {
    expect(ids("overdue")).toEqual(["b", "c"]);
  });

  it("lists work currently in progress", () => {
    expect(ids("in-progress")).toEqual(["c"]);
  });

  it("lists only work completed today", () => {
    expect(ids("completed-today")).toEqual(["d"]);
  });
});

describe("every action on the personal work surface is capability gated", () => {
  const src = readFileSync("src/routes/_shell.housekeeping.my-work.tsx", "utf8");

  it("names a precise capability per action rather than a broad module grant", () => {
    expect(src).toContain('can("housekeeping", "cleaning", "start")');
    expect(src).toContain('can("housekeeping", "cleaning", "complete")');
    expect(src).toContain('can("housekeeping", "supply-need", "report")');
    // Reporting a supply need must never demand Stores requisition authority.
    expect(src).not.toContain('can("stores"');
    expect(src).toContain('can("maintenance", "work-orders", "create")');
    expect(src).toContain('can("housekeeping", "lost-found", "report")');
    expect(src).not.toContain('can("housekeeping", "my-work.edit")');
  });

  it("renders each action only behind its own gate", () => {
    expect(src).toContain("mayReportFault ? (");
    expect(src).toContain("mayReportLostFound ? (");
    expect(src).toContain("mayReportSupplies ? (");
    expect(src).toContain("mayStart &&");
    expect(src).toContain("mayComplete &&");
  });
});

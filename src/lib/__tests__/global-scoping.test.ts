import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  dedupeDepartments,
  dedupeStations,
  pruneScopeSelection,
  scopeWorkers,
  scopedDepartmentIdentity,
  scopedLabel,
  slugifyDepartment,
  workerLabel,
  type ScopedDepartment,
  type ScopedStation,
  type ScopedWorker,
} from "@/lib/scoped-options";

const NAIROBI = "11111111-1111-1111-1111-111111111111";
const TAVETA = "22222222-2222-2222-2222-222222222222";

const departments: ScopedDepartment[] = [
  { id: "d-org-fin", name: "Finance", catalogue_key: "finance", branch_id: null, branch_name: null },
  { id: "d-nbo-fin", name: "Finance", catalogue_key: "finance", branch_id: NAIROBI, branch_name: "Nairobi" },
  { id: "d-tvt-fin", name: "Finance", catalogue_key: "finance", branch_id: TAVETA, branch_name: "Taveta" },
  { id: "d-org-hk", name: "Housekeeping", catalogue_key: "housekeeping", branch_id: null, branch_name: null },
];

const stations: ScopedStation[] = [
  { id: "s-nbo-hot", name: "Hot Kitchen", code: "HOT", station_type: "kitchen", department_id: "d-nbo-kit", branch_id: NAIROBI, branch_name: "Nairobi" },
  { id: "s-tvt-hot", name: "Hot Kitchen", code: "HOT", station_type: "kitchen", department_id: "d-tvt-kit", branch_id: TAVETA, branch_name: "Taveta" },
  { id: "s-org-hot", name: "Hot Kitchen", code: "HOT", station_type: "kitchen", department_id: null, branch_id: null, branch_name: null },
];

const workers: ScopedWorker[] = [
  { id: "p-nbo-hk", full_name: "Amina Yusuf", staff_id: "SCN-HK-001", job_title: "Room Attendant", department_id: "d-org-hk", department_name: "Housekeeping", branch_id: NAIROBI, branch_name: "Nairobi" },
  { id: "p-tvt-hk", full_name: "Brian Otieno", staff_id: "SCN-HK-050", job_title: "Room Attendant", department_id: "d-org-hk", department_name: "Housekeeping", branch_id: TAVETA, branch_name: "Taveta" },
  { id: "p-nbo-mnt", full_name: "Caleb Mwangi", staff_id: "SCN-MT-004", job_title: "Technician", department_id: "d-nbo-mnt", department_name: "Maintenance", branch_id: NAIROBI, branch_name: "Nairobi" },
];

describe("department scoping", () => {
  it("hides the organisation-wide record when the property has its own", () => {
    const result = dedupeDepartments(departments, NAIROBI);
    const finance = result.filter((d) => d.catalogue_key === "finance");
    expect(finance).toHaveLength(1);
    expect(finance[0]!.id).toBe("d-nbo-fin");
  });

  it("keeps the organisation-wide record when the property has no equivalent", () => {
    expect(dedupeDepartments(departments, NAIROBI).some((d) => d.id === "d-org-hk")).toBe(true);
  });

  it("never offers another property's department to a branch-scoped user", () => {
    expect(dedupeDepartments(departments, NAIROBI).some((d) => d.branch_id === TAVETA)).toBe(false);
  });

  it("keeps legitimate branch-specific instances in All Properties mode", () => {
    const all = dedupeDepartments(departments, null);
    expect(all.filter((d) => d.catalogue_key === "finance").map((d) => d.id).sort()).toEqual([
      "d-nbo-fin",
      "d-org-fin",
      "d-tvt-fin",
    ]);
  });

  it("labels identical concepts by property in All Properties mode", () => {
    expect(scopedLabel("Finance", "Nairobi", true)).toBe("Finance — Nairobi");
    expect(scopedLabel("Finance", "Nairobi", false)).toBe("Finance");
  });

  it("derives canonical identity from the catalogue key, falling back to the name", () => {
    expect(scopedDepartmentIdentity({ name: "Finance", catalogue_key: "finance" })).toBe("finance");
    expect(scopedDepartmentIdentity({ name: "Front Office", catalogue_key: null })).toBe("front office");
    expect(slugifyDepartment("Main Kitchen")).toBe("main-kitchen");
  });
});

describe("station scoping", () => {
  it("offers only the selected property's stations, deduplicated", () => {
    const result = dedupeStations(stations, NAIROBI, null);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("s-nbo-hot");
  });

  it("drops a station that names another department, keeping departmentless ones", () => {
    const result = dedupeStations(stations, NAIROBI, "d-nbo-pastry");
    expect(result.map((s) => s.id)).toEqual(["s-org-hot"]);
  });
});

describe("worker scoping and canonical identity", () => {
  it("offers only same-property workers of the requested department", () => {
    const result = scopeWorkers(workers, NAIROBI, null, "housekeeping");
    expect(result.map((w) => w.id)).toEqual(["p-nbo-hk"]);
  });

  it("never offers a cross-property housekeeper", () => {
    expect(scopeWorkers(workers, NAIROBI, null, "housekeeping").some((w) => w.id === "p-tvt-hk")).toBe(false);
  });

  it("scopes maintenance, event, laundry and rider style selectors the same way", () => {
    expect(scopeWorkers(workers, NAIROBI, null, "maintenance").map((w) => w.id)).toEqual(["p-nbo-mnt"]);
    expect(scopeWorkers(workers, TAVETA, null, "maintenance")).toHaveLength(0);
  });

  it("lets an organisation-scoped view see every property's workers", () => {
    expect(scopeWorkers(workers, null, null, "housekeeping").map((w) => w.id).sort()).toEqual([
      "p-nbo-hk",
      "p-tvt-hk",
    ]);
  });

  it("submits the canonical profile id and uses staff id only as a label", () => {
    const [worker] = scopeWorkers(workers, NAIROBI, null, "housekeeping");
    expect(worker!.id).toBe("p-nbo-hk");
    expect(worker!.id).not.toBe(worker!.staff_id);
    expect(workerLabel(worker!)).toBe("Amina Yusuf (SCN-HK-001 · Room Attendant)");
    expect(workerLabel(worker!, true)).toContain("— Nairobi");
  });

  it("pins housekeeping assignment to Property → Department → Role → Active Worker validation", () => {
    const migration = readFileSync("supabase/migrations/20260825105936_a53ef6b2-a6e9-457f-b4c0-89f7346a46f4.sql", "utf8");
    expect(migration).toContain("public.neo_assert_worker_scope(_assignee, v_job.branch_id, 'housekeeping')");
    expect(migration).toContain("public.neo_assert_worker_scope(_assignee, v_room.branch_id, 'housekeeping')");
    expect(migration).toContain("JOIN public.employees e");
    expect(migration).toContain("JOIN public.user_roles ur");
    expect(migration).toContain("JOIN public.roles r");
    expect(migration).toContain("That worker belongs to another property");
    expect(migration).toContain("That worker does not hold an active role for the requested department");
  });
});

describe("dependent selections", () => {
  it("clears a department, station and worker the new property no longer permits", () => {
    const pruned = pruneScopeSelection(
      departments,
      stations,
      workers,
      TAVETA,
      "d-nbo-fin",
      "s-nbo-hot",
      "p-nbo-hk",
    );
    expect(pruned).toEqual({ departmentId: null, stationId: null, workerId: null });
  });

  it("keeps selections that remain valid", () => {
    const pruned = pruneScopeSelection(departments, stations, workers, NAIROBI, "d-nbo-fin", null, "p-nbo-hk");
    expect(pruned.departmentId).toBe("d-nbo-fin");
    expect(pruned.workerId).toBe("p-nbo-hk");
  });
});

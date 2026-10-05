/**
 * Shared selector scoping contract.
 *
 * One rule for the whole OS: every relational selector filters by the active
 * property first, then narrows by the parent relationship on that form
 * (property â†’ department â†’ station â†’ worker). Only an organisation-scoped
 * account may view "All Properties"; administrative rights alone never widen
 * property reach — that decision belongs to `useBranchScope()` and is simply
 * consumed here.
 *
 * The backend enforces the same chain (`neo_scoped_departments`,
 * `neo_scoped_stations`, `neo_scoped_workers`, `neo_assert_scope_chain`,
 * `neo_assert_worker_scope`), so this module never widens what the database
 * allows — it only keeps the screen honest.
 *
 * Canonical identity: a worker option's value is always `profiles.id`, never an
 * employee record id or a display staff number. Name, staff id and job title are
 * labels only.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// The scoping RPCs are additive and not yet in the generated typings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ScopedDepartment = {
  id: string;
  name: string;
  catalogue_key: string | null;
  branch_id: string | null;
  branch_name: string | null;
  branch_specific?: boolean;
};

export type ScopedStation = {
  id: string;
  name: string;
  code: string | null;
  station_type: string | null;
  department_id: string | null;
  branch_id: string | null;
  branch_name: string | null;
};

export type ScopedWorker = {
  /** Canonical identity — this is what every backend routine expects. */
  id: string;
  full_name: string;
  staff_id: string | null;
  job_title: string | null;
  department_id: string | null;
  department_name: string | null;
  branch_id: string | null;
  branch_name: string | null;
};

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-testable, no network)
 * ------------------------------------------------------------------ */

/** Canonical slug of a department name, matching the database identity rule. */
export function slugifyDepartment(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Canonical identity of a department: catalogue key first, name as last resort. */
export function scopedDepartmentIdentity(d: Pick<ScopedDepartment, "name" | "catalogue_key">): string {
  const key = (d.catalogue_key ?? "").trim();
  return key !== "" ? key : d.name.trim().toLowerCase();
}

/**
 * Label an option for the operator. Inside a single property the bare name is
 * unambiguous; in All Properties mode identical concepts are disambiguated by
 * property — "Finance — Nairobi", "Finance — Taveta".
 */
export function scopedLabel(
  name: string,
  branchName: string | null | undefined,
  orgWideView: boolean,
): string {
  return orgWideView && branchName ? `${name} — ${branchName}` : name;
}

/** A worker label never replaces the canonical value; it only helps the eye. */
export function workerLabel(worker: ScopedWorker, orgWideView = false): string {
  const detail = [worker.staff_id, worker.job_title].filter((v) => (v ?? "").trim() !== "").join(" · ");
  const base = detail ? `${worker.full_name} (${detail})` : worker.full_name;
  return scopedLabel(base, worker.branch_name, orgWideView);
}

/**
 * Departments offered for the selected property, deduplicated by canonical
 * identity. A property-specific record always hides the organisation-wide
 * record of the same concept. In All Properties mode each property keeps its
 * own record, because those are genuinely different departments.
 */
export function dedupeDepartments(
  departments: ScopedDepartment[],
  branchId: string | null | undefined,
): ScopedDepartment[] {
  const usable = departments.filter(
    (d) => !branchId || d.branch_id === branchId || d.branch_id === null,
  );
  const best = new Map<string, ScopedDepartment>();
  for (const dept of usable) {
    const ident = scopedDepartmentIdentity(dept);
    const key = branchId ? ident : `${dept.branch_id ?? "org"}::${ident}`;
    const held = best.get(key);
    if (!held || (held.branch_id === null && dept.branch_id !== null)) best.set(key, dept);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Stations valid for the selected property and department, deduplicated by name. */
export function dedupeStations(
  stations: ScopedStation[],
  branchId: string | null | undefined,
  departmentId: string | null | undefined,
): ScopedStation[] {
  const usable = stations.filter(
    (s) =>
      (!branchId || s.branch_id === branchId || s.branch_id === null) &&
      (!departmentId || s.department_id === null || s.department_id === departmentId),
  );
  const best = new Map<string, ScopedStation>();
  for (const station of usable) {
    const ident = station.name.trim().toLowerCase();
    const key = branchId ? ident : `${station.branch_id ?? "org"}::${ident}`;
    const held = best.get(key);
    if (
      !held ||
      (held.branch_id === null && station.branch_id !== null) ||
      (held.department_id === null && station.department_id !== null)
    ) {
      best.set(key, station);
    }
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Workers offered for the selected property and department. A worker with no
 * property of their own cannot be proven wrong, so they stay; a worker of
 * another property is never offered.
 */
export function scopeWorkers(
  workers: ScopedWorker[],
  branchId: string | null | undefined,
  departmentId?: string | null,
  departmentKey?: string | null,
): ScopedWorker[] {
  return workers
    // A property-specific selector must contain only workers explicitly attached
    // to that property. An unassigned worker is not silently treated as valid.
    .filter((w) => !branchId || w.branch_id === branchId)
    .filter((w) => {
      // A department-specific selector is equally strict: only workers whose
      // staff record resolves to that exact department may be assigned.
      if (departmentId) return w.department_id === departmentId;
      if (departmentKey) {
        if (!w.department_id) return false;
        return slugifyDepartment(w.department_name ?? "") === departmentKey;
      }
      return true;
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** Drops a dependent selection the new parent no longer permits. */
export function pruneScopeSelection(
  departments: ScopedDepartment[],
  stations: ScopedStation[],
  workers: ScopedWorker[],
  branchId: string | null,
  departmentId: string | null,
  stationId: string | null,
  workerId: string | null,
): { departmentId: string | null; stationId: string | null; workerId: string | null } {
  const dept =
    departmentId && dedupeDepartments(departments, branchId).some((d) => d.id === departmentId)
      ? departmentId
      : null;
  const station =
    stationId && dedupeStations(stations, branchId, dept).some((s) => s.id === stationId)
      ? stationId
      : null;
  const worker =
    // A worker is judged on property reach only — the department field on a form
    // is not necessarily the worker's own department.
    workerId && scopeWorkers(workers, branchId).some((w) => w.id === workerId) ? workerId : null;
  return { departmentId: dept, stationId: station, workerId: worker };
}

/* ------------------------------------------------------------------ *
 * Hooks — the property scope always comes from the header selection
 * ------------------------------------------------------------------ */

export function useScopedDepartments(branchOverride?: string | null) {
  const { organizationId } = useAuth();
  const { branchId: active } = useActivePropertyFilter();
  const branchId = branchOverride !== undefined ? branchOverride : active;
  return useQuery({
    queryKey: ["scope", "departments", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_scoped_departments", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      return (data ?? []) as ScopedDepartment[];
    },
  });
}

export function useScopedStations(departmentId?: string | null, branchOverride?: string | null) {
  const { organizationId } = useAuth();
  const { branchId: active } = useActivePropertyFilter();
  const branchId = branchOverride !== undefined ? branchOverride : active;
  return useQuery({
    queryKey: ["scope", "stations", organizationId, branchId, departmentId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_scoped_stations", {
        _branch: branchId ?? null,
        _department: departmentId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as ScopedStation[];
    },
  });
}

/**
 * Canonical worker catalogue for a property (and optionally a department).
 * `departmentKey` is the canonical department identity — "housekeeping",
 * "maintenance", "main-kitchen", "laundry", "delivery" and so on — so a
 * property using the organisation-wide department record still resolves.
 */
export function useScopedWorkers(options?: {
  departmentId?: string | null;
  departmentKey?: string | null;
  branch?: string | null;
  enabled?: boolean;
}) {
  const { organizationId } = useAuth();
  const { branchId: active } = useActivePropertyFilter();
  const branchId = options?.branch !== undefined ? options.branch : active;
  const departmentId = options?.departmentId ?? null;
  const departmentKey = options?.departmentKey ?? null;
  return useQuery({
    queryKey: ["scope", "workers", organizationId, branchId, departmentId, departmentKey],
    enabled: Boolean(organizationId) && (options?.enabled ?? true),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_scoped_workers", {
        _branch: branchId ?? null,
        _department: departmentId,
        _department_key: departmentKey,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as ScopedWorker[];
    },
  });
}

/** Convenience: label helper bound to the current viewing mode. */
export function useScopedLabeller() {
  const { orgWide, branchId } = useActivePropertyFilter();
  const orgWideView = orgWide && !branchId;
  return useMemo(
    () => ({
      orgWideView,
      label: (name: string, branchName: string | null | undefined) =>
        scopedLabel(name, branchName, orgWideView),
      worker: (w: ScopedWorker) => workerLabel(w, orgWideView),
    }),
    [orgWideView],
  );
}

/** Guard for forms: a property-bound record cannot be saved in All Properties mode. */
export function useRequireProperty() {
  const { branchId } = useActivePropertyFilter();
  return useCallback(() => {
    if (!branchId) {
      throw new Error(
        "Select a property in the header before saving this record — â€œAll Propertiesâ€ is a viewing mode only.",
      );
    }
    return branchId;
  }, [branchId]);
}

/* ------------------------------------------------------------------ *
 * Department resolution by canonical identity
 *
 * Modules used to find "their" department with an ilike search over the whole
 * `departments` table, which happily returned another property's record. The
 * scoped catalogue is now the only source: property first, then canonical
 * identity, with the organisation-wide record used only when the property has
 * no equivalent of its own.
 * ------------------------------------------------------------------ */

export type ResolvedDepartment = {
  id: string;
  name: string;
  code: string | null;
  branch_id: string | null;
  branch_name: string | null;
};

/**
 * Resolve one department for the active property by canonical identity.
 * `pattern` is a regular-expression source tested against the canonical key and
 * the department name — e.g. `"housekeep|hk"`.
 */
export function useScopedDepartmentByKey(pattern: string, branchOverride?: string | null) {
  const query = useScopedDepartments(branchOverride);
  const { branchId: active } = useActivePropertyFilter();
  const branchId = branchOverride !== undefined ? branchOverride : active;
  const rows = query.data;
  const data = useMemo<ResolvedDepartment | null>(() => {
    const test = new RegExp(pattern, "i");
    const list = dedupeDepartments(rows ?? [], branchId);
    const hit =
      list.find((d) => test.test(scopedDepartmentIdentity(d))) ??
      list.find((d) => test.test(d.name)) ??
      null;
    return hit
      ? {
          id: hit.id,
          name: hit.name,
          code: hit.catalogue_key,
          branch_id: hit.branch_id,
          branch_name: hit.branch_name,
        }
      : null;
  }, [
    rows,
    branchId,
    pattern,
  ]);
  return { ...query, data } as Omit<typeof query, "data"> & { data: ResolvedDepartment | null };
}

/**
 * Canonical worker options for any assignee selector in the OS.
 *
 * Never offers a worker of another property, always yields `profiles.id` as the
 * value, and — when a job-title hint is given — prefers the workers whose job
 * title matches, without hiding the rest of the property's staff when nobody
 * matches (an unassignable list helps nobody).
 */
export function useScopedWorkerOptions(options?: {
  departmentId?: string | null;
  departmentKey?: string | null;
  branch?: string | null;
  enabled?: boolean;
  /** Regular-expression source matched against the job title, as a preference. */
  jobTitlePattern?: string | null;
}) {
  const query = useScopedWorkers({
    ...(options?.departmentId !== undefined ? { departmentId: options.departmentId } : {}),
    ...(options?.departmentKey !== undefined ? { departmentKey: options.departmentKey } : {}),
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.enabled !== undefined ? { enabled: options.enabled } : {}),
  });
  const { branchId } = useActivePropertyFilter();
  const rows = query.data;
  const pattern = options?.jobTitlePattern ?? null;
  const data = useMemo<ScopedWorker[]>(() => {
    const scoped = scopeWorkers(
      rows ?? [],
      branchId,
      options?.departmentId ?? null,
      options?.departmentKey ?? null,
    );
    if (!pattern) return scoped;
    const test = new RegExp(pattern, "i");
    const preferred = scoped.filter((w) => test.test(w.job_title ?? ""));
    return preferred.length > 0 ? preferred : scoped;
  }, [
    rows,
    branchId,
    pattern,
  ]);
  return { ...query, data } as Omit<typeof query, "data"> & { data: ScopedWorker[] };
}

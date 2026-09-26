/**
 * Kitchen production visibility contract.
 *
 * Mirrors `public.neo_kitchen_visible_station_ids()` and the
 * `station_tickets_production_read` RLS policy. This module is the executable
 * documentation of the rule — the database remains authoritative.
 *
 * Rule (in order):
 *  1. Tenant boundary: the ticket must belong to the viewer's organisation.
 *  2. Property boundary: below organisation/technical reach, the station's
 *     property must be one of the viewer's properties.
 *  3. Reach:
 *     - organisation / technical scope  → every production station,
 *     - `kitchen.all_stations.view`     → every production station at the property,
 *     - explicitly assigned station(s)  → those stations,
 *     - department scope or above       → stations of the viewer's department(s),
 *     - frontline (team/self) scope     → assigned stations only.
 *  4. The viewer must additionally hold `kitchen.queue.view`.
 */

export const SCOPE_RANK: Record<string, number> = {
  organisation: 5,
  technical: 5,
  branch: 4,
  department: 3,
  team: 2,
  self: 1,
};

export function scopeRank(scope: string | null | undefined) {
  return SCOPE_RANK[scope ?? "self"] ?? 1;
}

export type VisibilityViewer = {
  organizationId: string;
  scope: string;
  branchIds: string[];
  departmentIds: string[];
  stationIds: string[];
  /** kitchen.all_stations.view */
  allStations: boolean;
  /** kitchen.queue.view */
  queueView: boolean;
};

export type VisibilityStation = {
  id: string;
  organizationId: string;
  branchId: string | null;
  departmentId: string | null;
};

export function visibleStationIds(
  viewer: VisibilityViewer,
  stations: VisibilityStation[],
): string[] {
  const universal = scopeRank(viewer.scope) >= 5;
  return stations
    .filter((s) => s.organizationId === viewer.organizationId)
    .filter((s) => universal || s.branchId == null || viewer.branchIds.includes(s.branchId))
    .filter(
      (s) =>
        universal ||
        viewer.allStations ||
        viewer.stationIds.includes(s.id) ||
        // Departmental reach is supervisory only: frontline staff (team/self)
        // see the station(s) they are assigned to, never every station that
        // happens to share their department.
        (scopeRank(viewer.scope) >= 3 &&
          s.departmentId != null &&
          viewer.departmentIds.includes(s.departmentId)),
    )
    .map((s) => s.id);
}

export type VisibilityTicket = {
  organizationId: string;
  stationId: string | null;
};

export function canSeeProductionTicket(
  viewer: VisibilityViewer,
  ticket: VisibilityTicket,
  stations: VisibilityStation[],
): boolean {
  if (!viewer.queueView) return false;
  if (ticket.organizationId !== viewer.organizationId) return false;
  if (!ticket.stationId) return false;
  return visibleStationIds(viewer, stations).includes(ticket.stationId);
}

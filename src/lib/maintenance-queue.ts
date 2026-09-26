/**
 * Assignment-driven maintenance queues.
 *
 * A maintenance list ordered by creation date tells nobody what to do next. A
 * work order belongs to an officer, sits at a step, has one next action, is
 * either within or past its SLA, may be holding a room out of sale, and carries
 * the trail of who moved it. This module derives all of that from the records
 * the module already stores, so the technician's queue, the supervisor's queue
 * and the room-impact view are three reads of one truth.
 */

export type WorkOrderStep =
  | "reported"
  | "triaged"
  | "assigned"
  | "in_progress"
  | "awaiting_parts"
  | "completed"
  | "inspected"
  | "closed"
  | "cancelled";

export const WORK_ORDER_STEPS: readonly WorkOrderStep[] = [
  "reported",
  "triaged",
  "assigned",
  "in_progress",
  "awaiting_parts",
  "completed",
  "inspected",
  "closed",
  "cancelled",
];

const OPEN_STEPS = new Set<WorkOrderStep>([
  "reported",
  "triaged",
  "assigned",
  "in_progress",
  "awaiting_parts",
  "completed",
]);

export type Priority = "critical" | "high" | "normal" | "low";

/** Hours allowed at a given priority before the job is breaching. */
export const SLA_HOURS: Record<Priority, number> = {
  critical: 4,
  high: 12,
  normal: 48,
  low: 120,
};

export type WorkOrderRecord = {
  id: string;
  reference: string | null;
  organizationId: string;
  propertyId: string;
  step: WorkOrderStep;
  priority: Priority;
  assigneeId: string | null;
  assigneeName: string | null;
  supervisorId?: string | null;
  roomId?: string | null;
  roomNumber?: string | null;
  /** True when the fault takes the room out of sale. */
  blocksRoom?: boolean;
  reportedAt: string;
  dueAt?: string | null;
  audit?: Array<{ at: string; actor: string; action: string }>;
};

export type QueueEntry = {
  record: WorkOrderRecord;
  step: WorkOrderStep;
  owner: string;
  nextAction: string;
  /** Capability the UI must hold before offering `nextAction`. */
  permission: string;
  dueAt: string | null;
  slaState: "on-track" | "due-soon" | "breached" | "not-applicable";
  hoursRemaining: number | null;
  roomImpact: string | null;
  /** Sort weight — lower comes first. */
  rank: number;
  audit: Array<{ at: string; actor: string; action: string }>;
};

const NEXT: Record<WorkOrderStep, { owner: string; action: string; permission: string }> = {
  reported: { owner: "Maintenance Supervisor", action: "Triage the fault and set priority", permission: "maintenance.workorders.edit" },
  triaged: { owner: "Maintenance Supervisor", action: "Assign an officer", permission: "maintenance.workorders.assign" },
  assigned: { owner: "Assigned officer", action: "Start the job", permission: "maintenance.workorders.edit" },
  in_progress: { owner: "Assigned officer", action: "Complete the repair", permission: "maintenance.workorders.edit" },
  awaiting_parts: { owner: "Store Keeper", action: "Issue the required parts", permission: "stores.issues.create" },
  completed: { owner: "Maintenance Supervisor", action: "Inspect the repair", permission: "maintenance.workorders.inspect" },
  inspected: { owner: "Front Office", action: "Return the room to sale", permission: "front-office.rooms.edit" },
  closed: { owner: "—", action: "", permission: "" },
  cancelled: { owner: "—", action: "", permission: "" },
};

export const isOpen = (step: WorkOrderStep) => OPEN_STEPS.has(step);

export function dueAtFor(record: WorkOrderRecord): string | null {
  if (record.dueAt) return record.dueAt;
  const reported = Date.parse(record.reportedAt);
  if (Number.isNaN(reported)) return null;
  return new Date(reported + SLA_HOURS[record.priority] * 3_600_000).toISOString();
}

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

export function queueEntry(record: WorkOrderRecord, now: Date = new Date()): QueueEntry {
  const next = NEXT[record.step];
  const due = isOpen(record.step) ? dueAtFor(record) : null;
  const hoursRemaining = due ? (Date.parse(due) - now.getTime()) / 3_600_000 : null;
  const slaState: QueueEntry["slaState"] = !isOpen(record.step)
    ? "not-applicable"
    : hoursRemaining === null
      ? "not-applicable"
      : hoursRemaining < 0
        ? "breached"
        : hoursRemaining <= 2
          ? "due-soon"
          : "on-track";

  const roomImpact = record.roomId
    ? record.blocksRoom
      ? `Room ${record.roomNumber ?? record.roomId} is out of sale`
      : `Room ${record.roomNumber ?? record.roomId} — sellable`
    : null;

  const slaWeight = slaState === "breached" ? 0 : slaState === "due-soon" ? 1 : 2;
  const rank =
    slaWeight * 1000 + PRIORITY_RANK[record.priority] * 100 + (record.blocksRoom ? 0 : 10);

  return {
    record,
    step: record.step,
    owner: record.assigneeName ?? next.owner,
    nextAction: next.action,
    permission: next.permission,
    dueAt: due,
    slaState,
    hoursRemaining,
    roomImpact,
    rank,
    audit: [...(record.audit ?? [])].sort((a, b) => a.at.localeCompare(b.at)),
  };
}

export type QueueScope =
  | { kind: "mine"; userId: string }
  | { kind: "unassigned" }
  | { kind: "property"; propertyId: string }
  | { kind: "supervising"; userId: string };

/** Human label — never call a property-wide queue "My jobs". */
export function scopeLabel(scope: QueueScope): string {
  switch (scope.kind) {
    case "mine":
      return "My jobs";
    case "unassigned":
      return "Unassigned";
    case "supervising":
      return "Jobs I supervise";
    case "property":
      return "Property workload";
  }
}

export function buildQueue(
  records: WorkOrderRecord[],
  scope: QueueScope,
  now: Date = new Date(),
): QueueEntry[] {
  const matches = (r: WorkOrderRecord) => {
    switch (scope.kind) {
      case "mine":
        return r.assigneeId === scope.userId;
      case "unassigned":
        return !r.assigneeId;
      case "supervising":
        return r.supervisorId === scope.userId;
      case "property":
        return r.propertyId === scope.propertyId;
    }
  };
  return records
    .filter((r) => isOpen(r.step) && matches(r))
    .map((r) => queueEntry(r, now))
    .sort((a, b) => a.rank - b.rank || (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
}

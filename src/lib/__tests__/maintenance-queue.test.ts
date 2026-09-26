import { describe, expect, it } from "vitest";
import {
  buildQueue,
  queueEntry,
  scopeLabel,
  type WorkOrderRecord,
} from "@/lib/maintenance-queue";

const now = new Date("2026-08-31T12:00:00Z");

const wo = (r: Partial<WorkOrderRecord> & Pick<WorkOrderRecord, "id">): WorkOrderRecord => ({
  reference: `WO-${r.id}`,
  organizationId: "org",
  propertyId: "prop-a",
  step: "assigned",
  priority: "normal",
  assigneeId: "tech-1",
  assigneeName: "Amina",
  reportedAt: "2026-08-31T08:00:00Z",
  ...r,
});

describe("a queue entry says who, what next and by when", () => {
  it("names the owner, the single next action and the capability behind it", () => {
    const e = queueEntry(wo({ id: "1", step: "completed", assigneeName: null }), now);
    expect(e.owner).toBe("Maintenance Supervisor");
    expect(e.nextAction).toBe("Inspect the repair");
    expect(e.permission).toBe("maintenance.workorders.inspect");
  });

  it("derives the SLA from priority when no due date is set", () => {
    const critical = queueEntry(wo({ id: "2", priority: "critical" }), now);
    expect(critical.dueAt).toBe("2026-08-31T12:00:00.000Z");
    expect(critical.slaState).toBe("due-soon");
    const breached = queueEntry(wo({ id: "3", priority: "critical", reportedAt: "2026-08-31T00:00:00Z" }), now);
    expect(breached.slaState).toBe("breached");
    expect(queueEntry(wo({ id: "4", priority: "low" }), now).slaState).toBe("on-track");
  });

  it("states the room impact", () => {
    expect(queueEntry(wo({ id: "5", roomId: "r", roomNumber: "113", blocksRoom: true }), now).roomImpact).toBe(
      "Room 113 is out of sale",
    );
    expect(queueEntry(wo({ id: "6" }), now).roomImpact).toBeNull();
  });

  it("carries the audit trail in order", () => {
    const e = queueEntry(
      wo({
        id: "7",
        audit: [
          { at: "2026-08-31T09:00:00Z", actor: "Supervisor", action: "assigned" },
          { at: "2026-08-31T08:00:00Z", actor: "Front Office", action: "reported" },
        ],
      }),
      now,
    );
    expect(e.audit.map((a) => a.action)).toEqual(["reported", "assigned"]);
  });

  it("closes out finished work rather than nagging about SLA", () => {
    expect(queueEntry(wo({ id: "8", step: "closed" }), now).slaState).toBe("not-applicable");
  });
});

describe("queues are assignment-driven", () => {
  const records = [
    wo({ id: "a", assigneeId: "tech-1", priority: "low" }),
    wo({ id: "b", assigneeId: "tech-1", priority: "critical", reportedAt: "2026-08-31T00:00:00Z", blocksRoom: true, roomId: "r1", roomNumber: "101" }),
    wo({ id: "c", assigneeId: null, assigneeName: null, step: "triaged" }),
    wo({ id: "d", assigneeId: "tech-2", supervisorId: "sup-1" }),
    wo({ id: "e", assigneeId: "tech-1", step: "closed" }),
  ];

  it("gives an officer only their own open jobs", () => {
    expect(buildQueue(records, { kind: "mine", userId: "tech-1" }, now).map((e) => e.record.id)).toEqual(["b", "a"]);
  });

  it("surfaces unassigned work separately", () => {
    expect(buildQueue(records, { kind: "unassigned" }, now).map((e) => e.record.id)).toEqual(["c"]);
  });

  it("gives a supervisor the jobs they supervise", () => {
    expect(buildQueue(records, { kind: "supervising", userId: "sup-1" }, now).map((e) => e.record.id)).toEqual(["d"]);
  });

  it("never labels the property workload as my jobs", () => {
    expect(buildQueue(records, { kind: "property", propertyId: "prop-a" }, now)).toHaveLength(4);
    expect(scopeLabel({ kind: "property", propertyId: "prop-a" })).toBe("Property workload");
    expect(scopeLabel({ kind: "mine", userId: "tech-1" })).toBe("My jobs");
  });

  it("puts breached, room-blocking work first", () => {
    const [first] = buildQueue(records, { kind: "property", propertyId: "prop-a" }, now);
    expect(first!.record.id).toBe("b");
  });
});

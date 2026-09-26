/**
 * Owner-UAT regressions: records must not disappear, counters must not lie,
 * and a table with an open bill must never read as free seating.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFloorState, effectiveTableStatus } from "@/lib/pos-floor";

const opsData = readFileSync("src/lib/operations-data.ts", "utf8");
const maintenance = readFileSync("src/routes/_shell.maintenance.index.tsx", "utf8");
const auditPage = readFileSync("src/routes/_shell.audit-logs.tsx", "utf8");
const financeControls = readFileSync("src/lib/finance-controls.ts", "utf8");
const styles = readFileSync("src/styles.css", "utf8");

describe("property-scoped reads project the column they are filtered by", () => {
  it("work orders and preventive plans select branch_id", () => {
    const workOrders = opsData.slice(opsData.indexOf('.from("maintenance_work_orders")'));
    expect(workOrders.slice(0, 700)).toContain("branch_id");
    const plans = opsData.slice(opsData.indexOf('.from("preventive_maintenance_plans")'));
    expect(plans.slice(0, 700)).toContain("branch_id");
  });
});

describe("maintenance counters", () => {
  it("recognises every live room-hold state, not just the literal 'blocked'", () => {
    expect(maintenance).toContain("holdsRoom");
    for (const state of ["out-of-order", "out-of-service", "under-maintenance"]) {
      expect(maintenance).toContain(state);
    }
  });

  it("reads blocked rooms from the canonical room state shared with Housekeeping", () => {
    expect(maintenance).toContain("blockedRooms");
    expect(maintenance).toContain("maintenance-fault");
  });

  it("withholds figures until the canonical reads settle", () => {
    expect(maintenance).toContain("orders.isPending");
    expect(maintenance).toContain("roomStates.isPending");
  });
});

describe("restaurant floor state", () => {
  const table = { id: "t1", code: "T1", capacity: 4, status: "available" };
  const order = {
    id: "o1",
    order_number: "POS-1",
    table_id: "t1",
    guest_count: 2,
    status: "served",
    grand_total: 1000,
    paid_total: 0,
    created_at: new Date().toISOString(),
  };

  it("never labels a table with an open bill as available", () => {
    const [state] = buildFloorState([table], [order]);
    expect(state?.status).not.toBe("available");
    expect(state?.status).toBe("bill-presented");
  });

  it("keeps the configured status when there is no open bill", () => {
    const [state] = buildFloorState([table], []);
    expect(state?.status).toBe("available");
  });

  it("treats in-service bills as occupied", () => {
    expect(effectiveTableStatus("in-progress")).toBe("occupied");
  });
});

describe("truthful states", () => {
  it("the audit trail distinguishes loading and failure from 'no activity'", () => {
    expect(auditPage).toContain("QueryState");
    expect(auditPage).toContain("logs.refetch");
  });

  it("the night audit reports completion only after reading the signed run back", () => {
    expect(financeControls).toContain("night_audit_runs");
    expect(financeControls).toContain("did not persist");
  });
});

describe("shell stability", () => {
  it("reserves the scrollbar gutter on the inner scroll column", () => {
    expect(styles).toContain("[data-shell-scroll] {\n  scrollbar-gutter: stable;");
  });
});

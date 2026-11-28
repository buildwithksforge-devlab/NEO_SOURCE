import {
  describe,
  expect,
  it,
} from "vitest";

import {
  employeePosActivity,
  type EmployeePosActivityRow,
} from "../employee-pos-activity";

const rows: EmployeePosActivityRow[] = [
  {
    profile_id: "employee-a",
    orders_created: 10,
    orders_currently_assigned: 2,
    created_orders_finalized: 7,
    created_orders_cancelled: 1,
    created_orders_voided: 2,
    finalized_bill_value: 35000,
  },
  {
    profile_id: "employee-b",
    orders_created: 4,
    orders_currently_assigned: 1,
    created_orders_finalized: 3,
    created_orders_cancelled: 0,
    created_orders_voided: 1,
    finalized_bill_value: 12000,
  },
];

describe("HR employee POS activity", () => {
  it("selects only the requested employee", () => {
    expect(
      employeePosActivity(rows, "employee-a"),
    ).toEqual({
      ordersCreated: 10,
      currentlyAssigned: 2,
      finalized: 7,
      cancelled: 1,
      voided: 2,
      finalizedBillValue: 35000,
    });
  });

  it("does not combine different employees", () => {
    const result = employeePosActivity(
      rows,
      "employee-b",
    );

    expect(result?.finalizedBillValue).toBe(12000);
    expect(result?.ordersCreated).toBe(4);
  });

  it("returns null for an unlinked HR employee", () => {
    expect(
      employeePosActivity(rows, null),
    ).toBeNull();
  });

  it("returns null when no attributed activity exists", () => {
    expect(
      employeePosActivity(rows, "employee-c"),
    ).toBeNull();
  });

  it("handles finite numeric strings", () => {
    const result = employeePosActivity(
      [{
        ...rows[0]!,
        orders_created: "12",
        finalized_bill_value: "4500.50",
      }],
      "employee-a",
    );

    expect(result?.ordersCreated).toBe(12);
    expect(result?.finalizedBillValue).toBe(4500.5);
  });

  it("prevents invalid numeric values in the summary", () => {
    const result = employeePosActivity(
      [{
        ...rows[0]!,
        finalized_bill_value: "invalid",
      }],
      "employee-a",
    );

    expect(result?.finalizedBillValue).toBe(0);
  });

  it("does not mutate reporting rows", () => {
    const before = JSON.stringify(rows);

    employeePosActivity(rows, "employee-a");

    expect(JSON.stringify(rows)).toBe(before);
  });
});

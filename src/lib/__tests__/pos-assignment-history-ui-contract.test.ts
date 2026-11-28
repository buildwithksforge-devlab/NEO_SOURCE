
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(
  "src/routes/_shell.pos.orders.$id.tsx",
  "utf8",
);

const data = readFileSync(
  "src/lib/pos-data.ts",
  "utf8",
);

describe("POS assignment history integration", () => {
  it("uses the existing protected Order Terminal", () => {
    expect(route).toContain(
      '<PosGuard action="orders.view">',
    );
    expect(route).toContain(
      "function PosAssignmentHistoryCard(",
    );
  });

  it("connects history to the current order", () => {
    expect(route).toContain(
      "<PosAssignmentHistoryCard orderId={data.id} />",
    );
  });

  it("loads history through a read-only query", () => {
    const hook = data.split(
      "export function usePosAssignmentHistory(",
    )[1]?.split("export function usePosOrder(")[0];

    expect(hook).toBeDefined();
    expect(hook).toContain(
      '.from("pos_order_assignment_history" as never)',
    );
    expect(hook).toContain(
      '.eq("order_id", orderId!)',
    );
    expect(hook).not.toContain(".insert(");
    expect(hook).not.toContain(".update(");
    expect(hook).not.toContain(".delete(");
  });

  it("distinguishes baseline from actual transfers", () => {
    expect(route).toContain("Historical baseline");
    expect(route).toContain("Order transferred");
    expect(route).toContain(
      "Earlier transfer history is unavailable.",
    );
  });


  it("supports database-side history pagination", () => {
    expect(data).toContain(
      "export function usePosAssignmentHistory(",
    );
    expect(data).toContain(
      ".range(page * 50, page * 50 + 49)",
    );
    expect(data).toContain(
      "pageSize: 50",
    );
  });

  it("allows staff to navigate older assignment events", () => {
    expect(route).toContain(
      "usePosAssignmentHistory(orderId, page)",
    );
    expect(route).toContain("Previous");
    expect(route).toContain("Next");
    expect(route).toContain(
      "setPage((value) => value + 1)",
    );
  });

  it("preserves the existing payment section", () => {
    expect(route).toContain(
      '<SectionCard title="Payments"',
    );
  });
});

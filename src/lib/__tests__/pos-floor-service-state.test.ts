import { describe, expect, it } from "vitest";
import { SERVICE_ATTENTION_MINUTES, buildFloorState, summariseFloor } from "@/lib/pos-floor";
import { elapsedLabel, productionLabel } from "@/components/pos/FloorTableCard";

const NOW = new Date("2026-08-29T12:00:00.000Z").getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const tables = [
  {
    id: "t1",
    code: "T1",
    capacity: 4,
    status: "ordering",
    restaurant_areas: { name: "Terrace" },
  },
  { id: "t2", code: "T2", capacity: 2, status: "available", restaurant_areas: { name: "Terrace" } },
  { id: "t3", code: "T3", capacity: 6, status: "ordering", restaurant_areas: null },
];

const orders = [
  {
    id: "o1",
    order_number: "POS-1",
    table_id: "t1",
    guest_count: 3,
    status: "preparing",
    grand_total: 4200,
    paid_total: 1200,
    currency: "KES",
    created_at: minutesAgo(20),
    profiles: { full_name: "Amina W." },
  },
  {
    id: "o3",
    order_number: "POS-3",
    table_id: "t3",
    guest_count: 5,
    status: "sent",
    grand_total: 9000,
    paid_total: 0,
    created_at: minutesAgo(SERVICE_ATTENTION_MINUTES + 5),
    profiles: null,
  },
];

describe("restaurant floor service state", () => {
  it("derives live service context only for tables with an open bill", () => {
    const state = buildFloorState(tables, orders, NOW);
    const t1 = state.find((t) => t.id === "t1")!;
    expect(t1.order).toMatchObject({
      orderNumber: "POS-1",
      guestCount: 3,
      waiterName: "Amina W.",
      outstanding: 3000,
      elapsedMinutes: 20,
      needsAttention: false,
    });
    // No open bill means no invented figures at all.
    expect(state.find((t) => t.id === "t2")!.order).toBeUndefined();
  });

  it("falls back honestly for missing area and unassigned attendant", () => {
    const t3 = buildFloorState(tables, orders, NOW).find((t) => t.id === "t3")!;
    expect(t3.areaName).toBe("Unassigned area");
    expect(t3.order?.waiterName).toBeNull();
  });

  it("flags delayed service past the shared threshold", () => {
    const t3 = buildFloorState(tables, orders, NOW).find((t) => t.id === "t3")!;
    expect(t3.order?.needsAttention).toBe(true);
  });

  it("flags food sitting ready for more than fifteen minutes", () => {
    const state = buildFloorState(
      [tables[0]!],
      [{ ...orders[0]!, status: "ready", created_at: minutesAgo(20) }],
      NOW,
    );
    expect(state[0]!.order?.needsAttention).toBe(true);
  });

  it("keeps the most recent bill when a table carries more than one", () => {
    const state = buildFloorState(
      [tables[0]!],
      [
        { ...orders[0]!, id: "old", order_number: "POS-OLD", created_at: minutesAgo(200) },
        { ...orders[0]!, id: "new", order_number: "POS-NEW", created_at: minutesAgo(5) },
      ],
      NOW,
    );
    expect(state[0]!.order?.orderNumber).toBe("POS-NEW");
  });

  it("ignores orders that are not attached to a table", () => {
    const state = buildFloorState(tables, [{ ...orders[0]!, table_id: null }], NOW);
    expect(state.every((t) => t.order === undefined || t.id === "t3")).toBe(true);
  });

  it("summarises covers, attention and unpaid value from real rows only", () => {
    const summary = summariseFloor(buildFloorState(tables, orders, NOW));
    expect(summary).toMatchObject({
      total: 3,
      occupied: 2,
      available: 1,
      covers: 8,
      attention: 1,
      outstanding: 12_000,
    });
  });

  it("never reports negative outstanding for an overpaid bill", () => {
    const state = buildFloorState(
      [tables[0]!],
      [{ ...orders[0]!, grand_total: 1000, paid_total: 1500 }],
      NOW,
    );
    expect(state[0]!.order?.outstanding).toBe(0);
  });

  it("uses canonical service vocabulary shared with the kitchen", () => {
    expect(productionLabel("sent")).toBe("Sent to kitchen");
    expect(productionLabel("preparing")).toBe("In production");
    expect(productionLabel("ready")).toBe("Ready to serve");
  });

  it("formats elapsed service time for long-running tables", () => {
    expect(elapsedLabel(45)).toBe("45 min");
    expect(elapsedLabel(60)).toBe("1h");
    expect(elapsedLabel(135)).toBe("2h 15m");
  });
});

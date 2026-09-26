import { describe, expect, it } from "vitest";
import {
  countDeliveryStages,
  resolveDeliveryStage,
  type DeliveryStageInput,
} from "@/lib/delivery";

/**
 * One delivery walked from intake to delivered. Every screen reads this same
 * calculation, so the counts below are what the dashboard, the delivery queue
 * and the rider app must all show at each step.
 */
const base: DeliveryStageInput = {
  order_status: "pending-payment",
  kitchen_status: "not-sent",
  dispatch_status: "awaiting-kitchen",
  rider_id: null,
  collected_at: null,
  delivered_at: null,
};

describe("delivery stage resolver", () => {
  it("walks a delivery through every stage", () => {
    let order = { ...base };
    expect(resolveDeliveryStage(order)).toBe("intake");

    // Payment confirmed, kitchen has the ticket but has not finished.
    order = { ...order, order_status: "confirmed", kitchen_status: "preparing" };
    expect(resolveDeliveryStage(order)).toBe("kitchen");

    // Kitchen marks the ticket ready — the order is waiting for a rider even
    // though the order status still says "confirmed".
    order = { ...order, kitchen_status: "ready" };
    expect(resolveDeliveryStage(order)).toBe("awaiting-rider");
    expect(countDeliveryStages([order])["awaiting-rider"]).toBe(1);
    expect(countDeliveryStages([order])["kitchen"]).toBe(0);

    // Rider assigned but has not collected.
    order = { ...order, rider_id: "rider-1", dispatch_status: "rider-assigned" };
    expect(resolveDeliveryStage(order)).toBe("with-rider");

    // Pickup confirmed.
    order = { ...order, collected_at: "2026-09-14T09:00:00Z", dispatch_status: "collected" };
    expect(resolveDeliveryStage(order)).toBe("in-flight");

    // Delivery completed with proof of delivery.
    order = {
      ...order,
      delivered_at: "2026-09-14T09:30:00Z",
      dispatch_status: "delivered",
      order_status: "delivered",
    };
    expect(resolveDeliveryStage(order)).toBe("closed");
    expect(countDeliveryStages([order])["closed"]).toBe(1);
  });

  it("never treats a stale 'confirmed' order status as the stage", () => {
    expect(
      resolveDeliveryStage({ order_status: "confirmed", kitchen_status: "ready" }),
    ).toBe("awaiting-rider");
  });

  it("reports cancelled work separately from delivered work", () => {
    expect(resolveDeliveryStage({ order_status: "cancelled" })).toBe("cancelled");
    expect(resolveDeliveryStage({ order_status: "confirmed", dispatch_status: "returned" })).toBe(
      "cancelled",
    );
  });

  it("counts each order exactly once", () => {
    const counts = countDeliveryStages([
      { order_status: "confirmed", kitchen_status: "ready" },
      { order_status: "confirmed", kitchen_status: "preparing" },
      { order_status: "delivered" },
    ]);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import {
  guestNotificationCategoryLabel,
  guestNotificationTarget,
  unreadCount,
  type GuestNotification,
} from "@/lib/guest-notifications";

const row = (over: Partial<GuestNotification>): GuestNotification => ({
  id: "1",
  organization_id: "org",
  category: "stay",
  event_type: "booking_confirmed",
  title: "Booking confirmed",
  body: null,
  link: null,
  created_at: "2026-01-01T00:00:00Z",
  read_at: null,
  ...over,
});

describe("guest notification targets", () => {
  it("routes an order reference to the order screen", () => {
    expect(guestNotificationTarget("orders/DEL-2026-000006")).toEqual({
      kind: "order",
      reference: "DEL-2026-000006",
    });
  });

  it("routes a reservation reference to the booking screen", () => {
    expect(guestNotificationTarget("reservations/RES-1")).toEqual({
      kind: "reservation",
      reference: "RES-1",
    });
  });

  it("routes bare destinations", () => {
    expect(guestNotificationTarget("orders")).toEqual({ kind: "orders" });
    expect(guestNotificationTarget("laundry")).toEqual({ kind: "laundry" });
    expect(guestNotificationTarget("trips")).toEqual({ kind: "trips" });
  });

  it("never invents a destination", () => {
    expect(guestNotificationTarget(null)).toBeNull();
    expect(guestNotificationTarget("something-else")).toBeNull();
  });
});

describe("guest notification reading state", () => {
  it("counts only unread rows", () => {
    expect(
      unreadCount([row({ id: "a" }), row({ id: "b", read_at: "2026-01-02T00:00:00Z" })]),
    ).toBe(1);
    expect(unreadCount(undefined)).toBe(0);
  });

  it("labels known categories and falls back honestly", () => {
    expect(guestNotificationCategoryLabel("laundry")).toBe("Laundry");
    expect(guestNotificationCategoryLabel("mystery")).toBe("Updates");
  });
});

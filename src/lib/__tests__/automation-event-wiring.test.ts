import { describe, expect, it } from "vitest";
import { EVENT_CATALOGUE } from "@/lib/automation";

/**
 * Operational events that are now emitted by database triggers on real
 * records (pos_orders, station_tickets, tasks) must be advertised as live in
 * the automation catalogue, otherwise operators cannot build workflows on them.
 */
const LIVE_OPERATIONAL_EVENTS = ["order.created", "pos.ticket_routed", "task.assigned"];

describe("automation event wiring", () => {
  it.each(LIVE_OPERATIONAL_EVENTS)("%s is present and marked live", (type) => {
    const entry = EVENT_CATALOGUE.find((e) => e.type === type);
    expect(entry, `${type} missing from EVENT_CATALOGUE`).toBeDefined();
    expect(entry?.live).toBe(true);
  });

  it("never declares duplicate event types", () => {
    const types = EVENT_CATALOGUE.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

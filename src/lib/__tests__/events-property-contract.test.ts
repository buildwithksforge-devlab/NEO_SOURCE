import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { capabilityForPath } from "@/lib/capabilities";
import { EVENT_PROPERTY_TABLES, PROPERTY_REQUIRED_MESSAGE } from "@/lib/events-data";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const shell = readFileSync("src/routes/_shell.events.tsx", "utf8");
const dataLayer = readFileSync("src/lib/events-data.ts", "utf8");

/**
 * The Events module must resolve one property for every record it owns, and one
 * capability for every screen it offers. These are the invariants that broke
 * when the module read the signing-in user's home branch instead of the
 * property selector.
 */
describe("events property contract", () => {
  it("treats every property-bound events table as property-bound", () => {
    for (const table of [
      "event_bookings",
      "event_enquiries",
      "event_quotations",
      "event_venues",
      "event_resources",
      "event_packages",
      "site_visits",
      "venue_blocks",
    ]) {
      expect(EVENT_PROPERTY_TABLES.has(table), `${table} must be property scoped`).toBe(true);
    }
  });

  it("never treats shared configuration as property-bound", () => {
    expect(EVENT_PROPERTY_TABLES.has("event_types")).toBe(false);
  });

  it("reads the property from the global selector, never from the user profile", () => {
    expect(dataLayer).toContain("useActivePropertyFilter");
    expect(dataLayer).not.toContain("profile as { branch_id");
  });

  it("refuses to create a property-bound record while viewing all properties", () => {
    expect(dataLayer).toContain("throw new Error(PROPERTY_REQUIRED_MESSAGE)");
    expect(PROPERTY_REQUIRED_MESSAGE).toMatch(/Select a property/i);
  });

  it("creates events through the guarded server routine, not a raw insert", () => {
    expect(dataLayer).toContain("neo_event_booking_create");
    expect(RPC_MANIFEST["neo_event_booking_create"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_event_booking_transfer"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_event_workspace"]).toBe("authenticated");
  });

  it("offers one registered capability per events tab", () => {
    const tabs = [...shell.matchAll(/to: "(\/events[^"]*)", feature: "([^"]+)", action: "([^"]+)"/g)];
    expect(tabs.length).toBeGreaterThanOrEqual(14);
    for (const [, path, feature, action] of tabs) {
      const capability = capabilityForPath(path as string);
      expect(capability, `${path} must resolve to a capability`).not.toBeNull();
      expect(capability?.module).toBe("events");
      expect(capability?.feature).toBe(feature);
      expect(capability?.action).toBe(action);
    }
  });
});

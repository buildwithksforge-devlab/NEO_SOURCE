import { describe, expect, it } from "vitest";
import { NOTIFICATION_EVENTS, requiredCapabilityForLink } from "@/lib/notification-catalogue";
import { ROUTE_CAPABILITIES, UNIVERSAL_ROUTES, capabilityForPath, capabilityKey } from "@/lib/capabilities";

const registeredPrefixes = new Set(ROUTE_CAPABILITIES.map((entry) => entry.prefix));
/** Guest/rider apps live outside the staff capability registry. */
const PUBLIC_APP_PREFIXES = ["/rider", "/delivery/", "/guest"];

describe("operational notification catalogue", () => {
  it("declares a unique event key per notice", () => {
    const keys = NOTIFICATION_EVENTS.map((e) => e.event);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("routes every notice into an inbox view", () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(["action-required", "approvals", "tasks", "operational", "workflow"]).toContain(event.view);
      expect(event.category.length).toBeGreaterThan(0);
    }
  });

  it("points every deep link at a route the app actually serves", () => {
    for (const event of NOTIFICATION_EVENTS) {
      if (!event.linkPath) continue;
      if (event.publicApp) {
        expect(PUBLIC_APP_PREFIXES.some((p) => event.linkPath!.startsWith(p))).toBe(true);
        continue;
      }
      const known = UNIVERSAL_ROUTES.has(event.linkPath) || registeredPrefixes.has(event.linkPath);
      expect(known, `${event.event} links to unknown route ${event.linkPath}`).toBe(true);
    }
  });

  it("resolves each staff deep link to the capability its guard enforces", () => {
    for (const event of NOTIFICATION_EVENTS) {
      if (!event.linkPath || event.publicApp) continue;
      if (UNIVERSAL_ROUTES.has(event.linkPath)) {
        expect(requiredCapabilityForLink(event.linkPath)).toBeNull();
        continue;
      }
      const capability = capabilityForPath(event.linkPath);
      expect(capability, `${event.event} has no capability for ${event.linkPath}`).not.toBeNull();
      expect(requiredCapabilityForLink(event.linkPath)).toBe(capabilityKey(capability!));
    }
  });

  it("gives every action-required notice somewhere to act", () => {
    for (const event of NOTIFICATION_EVENTS.filter((e) => e.actionRequired)) {
      // Escalations carry a caller-supplied link; everything else is fixed.
      if (event.event === "workflow.escalation") continue;
      expect(event.linkPath, `${event.event} is actionable but has no link`).toBeTruthy();
    }
  });

  it("keeps approval notices pointed at approval-capable pages", () => {
    const approvals = NOTIFICATION_EVENTS.filter((e) => e.view === "approvals");
    expect(approvals.length).toBeGreaterThan(0);
    for (const event of approvals) {
      expect(event.actionRequired).toBe(true);
      expect(event.linkPath).toBeTruthy();
    }
  });
});

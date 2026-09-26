/**
 * Guards for the pre-presentation correction pass:
 *  1. the compact header clock format,
 *  2. the header's progressive-disclosure structure (nothing removed),
 *  3. Delivery Reports reading the *nested* metrics payload shape,
 *  4. folio row id -> /pms/folios/$id -> detail component using that id.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clockParts } from "@/components/layout/LiveClock";
import { metricGroup } from "@/lib/delivery-department";

const read = (p: string) => readFileSync(p, "utf8");

describe("header clock format", () => {
  const date = new Date("2026-08-27T09:03:00Z"); // 12:03 PM in Nairobi

  it("renders THU 27 AUG '26 and a 12-hour time without seconds", () => {
    const p = clockParts(date, "Africa/Nairobi");
    expect(p.date).toBe("THU 27 AUG '26");
    expect(p.time).toBe("12:03 PM");
    expect(p.time).not.toMatch(/:\d\d:\d\d/);
    expect(p.zone).toBe("EAT");
  });

  it("falls back safely for an unknown timezone", () => {
    const p = clockParts(date, "Not/AZone");
    expect(p.date).toMatch(/^[A-Z]{3} \d{2} [A-Z]{3} '\d{2}$/);
    expect(p.time).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe("global staff header structure", () => {
  const src = read("src/components/layout/Topbar.tsx");

  it("keeps the NEØ product mark permanently and shows the module label", () => {
    expect(src).toContain("<NeoGlyph");
    expect(src).toContain("data-module-label");
    expect(src).toContain("truncate");
  });

  it("retains every global utility action", () => {
    for (const target of [
      "/tasks",
      "/approvals",
      "/ai-insights",
      "/notifications",
      "ReportProblemDialog",
      "Toggle theme",
      "PropertySelector",
    ]) {
      expect(src).toContain(target);
    }
  });

  it("collapses lower-priority actions into an overflow menu instead of hiding them", () => {
    expect(src).toContain("data-header-overflow");
    expect(src).toContain('variant="menu"');
  });

  it("never allows the header row itself to overflow horizontally", () => {
    expect(src).toContain("overflow-hidden");
    expect(src).toContain("data-profile-trigger");
  });
});

describe("delivery reports data contract", () => {
  it("metricGroup reads the nested payload the routine actually returns", () => {
    const payload = {
      volume: { total: 12, delivered: 9 },
      service: { on_time_rate: 88.5 },
    };
    expect(metricGroup(payload, "volume")["total"]).toBe(12);
    expect(metricGroup(payload, "service")["on_time_rate"]).toBe(88.5);
    // Absent or non-object groups degrade to an empty map, never throw.
    expect(metricGroup(payload, "payments")).toEqual({});
    expect(metricGroup(undefined, "volume")).toEqual({});
    expect(metricGroup({ riders: 3 }, "riders")).toEqual({});
  });

  it("the reports route consumes groups, not the old flat keys", () => {
    const src = read("src/routes/_shell.delivery.reports.tsx");
    expect(src).toContain('metricGroup(data, "volume")');
    expect(src).toContain('metricGroup(data, "service")');
    expect(src).toContain("useDeliveryRiderPerformance");
    // The flat keys that silently rendered zeros must be gone.
    expect(src).not.toContain('data["orders"]');
    expect(src).not.toContain('data["on_time_rate"]');
    expect(src).not.toContain('data["riders"] as DeliveryRow[]');
    // Designed states remain wired.
    expect(src).toContain("QueryState");
    expect(src).toContain("EmptyState");
  });
});

describe("folio link and detail contract", () => {
  const list = read("src/routes/_shell.pms.folios.index.tsx");
  const detail = read("src/routes/_shell.pms.folios.$id.tsx");

  it("the folio number links to the specific folio detail route", () => {
    expect(list).toContain('to="/pms/folios/$id"');
    expect(list).toContain("params={{ id: f.id }}");
  });

  it("the detail route is registered on the id param and uses it for every read", () => {
    expect(detail).toContain('createFileRoute("/_shell/pms/folios/$id")');
    expect(detail).toContain("const { id } = Route.useParams();");
    expect(detail).toContain("useFolio(id)");
    expect(detail).toContain("useFolioLines(id)");
    expect(detail).toContain("useFolioPayments(id)");
  });

  it("the reservation folio tab also opens the folio by id", () => {
    const res = read("src/routes/_shell.pms.reservations.$id.tsx");
    expect(res).toContain('to="/pms/folios/$id"');
    expect(res).toContain("params={{ id: folio.id }}");
  });

  it("shows identity, financial summary, ledger and the premium statement", () => {
    // Canonical identity is rendered by the shared summary so guest statements,
    // refunds and account ledgers can never describe the folio differently.
    const identity = read("src/components/pms/FolioIdentitySummary.tsx");
    for (const marker of [
      'label="Property"',
      'label="Stay dates"',
      'label="Guest"',
      'label="Company / account"',
      'label="Billing instructions"',
      'label="Reservation"',
      'label="Room"',
    ]) {
      expect(identity).toContain(marker);
    }
    for (const marker of [
      "FolioIdentityFields",
      "FolioTraceDrawer",
      "Net charges",
      "Gross billed",
      "Collected",
      "Outstanding",
      "DocumentPrintButton",
      "FolioStatementBody",
      "All folios",
    ]) {
      expect(detail).toContain(marker);
    }
  });
});

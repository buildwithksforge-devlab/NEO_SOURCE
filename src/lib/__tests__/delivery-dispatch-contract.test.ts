/**
 * Delivery dispatch, rider eligibility and rider-notification contract.
 *
 * The deployed routines are exported verbatim into
 * `fixtures/delivery-dispatch.sql`, so these assertions run against the SQL the
 * database actually executes rather than a description of it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { ROLE_FEATURE_TEMPLATES, compileRoleTemplate } from "@/lib/role-templates";
import { moduleFeatures } from "@/lib/capabilities";

const SQL = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/delivery-dispatch.sql"), "utf8");

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const candidates = fn("neo_delivery_dispatch_candidates");
const assign = fn("neo_delivery_assign");
const roster = fn("neo_delivery_rider_roster");
const availability = fn("neo_delivery_rider_availability");
const notifications = fn("neo_delivery_rider_notifications");
const enrol = fn("neo_delivery_rider_enrol");
const retire = fn("neo_delivery_rider_retire");
const lifecycleNotify = fn("neo_rider_lifecycle_notify");
const shiftNotify = fn("neo_rider_shift_notify");
const capability = fn("neo_rider_holds_capability");

describe("server-side rider eligibility", () => {
  it("only dispatch or roster authority may read candidates", () => {
    expect(candidates).toContain("has_permission('delivery','dispatch.assign')");
    expect(candidates).toContain("has_permission('delivery','riders.manage')");
    expect(candidates).toContain("insufficient_privilege");
  });

  it("is organisation and property scoped", () => {
    expect(candidates).toContain("organization_id = _org");
    expect(candidates).toContain("neo_branch_in_scope");
  });

  it.each([
    ["retired accounts", "Retired from the roster"],
    ["unlinked staff", "No linked staff account"],
    ["inactive staff", "Staff account is inactive"],
    ["missing Rider capability", "does not hold the Rider capability"],
    ["other properties", "Assigned to a different property"],
    ["no active shift", "Not on an active shift"],
    ["the active-delivery ceiling", "At the active delivery ceiling"],
    ["cash clearance", "Not cleared to carry cash"],
  ])("returns an explicit reason for %s", (_label, reason) => {
    expect(candidates).toContain(reason);
  });

  it("reports self-availability other than 'available' as a reason", () => {
    expect(candidates).toContain("availability_status,'offline') <> 'available'");
    expect(candidates).toContain("'Rider is '");
  });

  it("treats an empty reason list as the only definition of eligible", () => {
    expect(candidates).toContain("cardinality(j.why) = 0");
  });

  it("derives shift cover, load and cash need from data, never from the caller", () => {
    expect(candidates).toContain("FROM public.rider_shifts s");
    expect(candidates).toContain("now() BETWEEN s.starts_at AND s.ends_at");
    expect(candidates).toContain("order_status NOT IN ('delivered','cancelled','rejected','failed')");
    expect(candidates).toContain("payment_method,'') IN ('cash','cash-on-delivery','cod')");
  });

  it("resolves the Rider capability from the staff role, not from a name", () => {
    expect(capability).not.toMatch(/display_name|full_name|email/i);
    expect(capability).toMatch(/user_roles|role/i);
  });
});

describe("assignment and reassignment", () => {
  it("refuses a rider the eligibility routine rejected, quoting the reasons", () => {
    expect(assign).toContain("neo_delivery_dispatch_candidates");
    expect(assign).toContain("rider_ineligible");
    expect(assign).toContain("'reasons', to_jsonb(_cand.reasons)");
  });

  it("requires a written reason before moving an order off its current rider", () => {
    expect(assign).toContain("_o.rider_id IS NOT NULL AND _reason_clean IS NULL");
    expect(assign).toContain("reason_required");
  });

  it("records previous rider, new rider, actor and time", () => {
    expect(assign).toContain("delivery_order_status_history");
    expect(assign).toContain("previous_status");
    expect(assign).toContain("auth.uid()");
    expect(assign).toContain("audit_logs");
  });

  it("notifies both the new rider and the rider who lost the order", () => {
    const notifyBlocks = assign.match(/INSERT INTO public\.notifications/g) ?? [];
    expect(notifyBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it("keys every rider notification so a retry cannot notify twice", () => {
    expect(assign).toContain("idempotency_key");
    expect(assign).toMatch(/ON CONFLICT[\s\S]{0,80}DO NOTHING/);
  });

  it("refuses closed orders and re-assignment to the same rider", () => {
    expect(assign).toContain("order_closed");
    expect(assign).toContain("already_assigned");
  });
});

describe("rider roster metrics", () => {
  it.each([
    "active_orders",
    "delivered_orders",
    "cancelled_orders",
    "on_time_rate",
    "avg_assignment_minutes",
    "avg_pickup_minutes",
  ])("publishes %s on the roster itself", (column) => {
    expect(roster).toContain(column);
  });

  it("exposes linkage and capability state so a broken rider account is visible", () => {
    expect(roster).toContain("holds_rider_capability");
    expect(roster).toContain("linkage_status");
    expect(roster).toContain("capability-missing");
  });
});

describe("availability is a server routine, not a table write", () => {
  it("validates the status and the rider's organisation", () => {
    expect(availability).toContain("invalid_status");
    expect(availability).toContain("rider_not_found");
  });

  it("writes availability history with actor and reason", () => {
    expect(availability).toContain("rider_availability_history");
    expect(availability).toContain("previous_status");
    expect(availability).toContain("auth.uid()");
  });

  it("notifies the rider when someone else changes their availability", () => {
    expect(availability).toContain("INSERT INTO public.notifications");
    expect(availability).toContain("idempotency_key");
  });
});

describe("rider notification audit trail", () => {
  it("returns the source key and delivery state so duplicates can be proven absent", () => {
    expect(notifications).toContain("idempotency_key");
    expect(notifications).toContain("delivery_status");
    expect(notifications).toContain("duplicate_suppressed");
  });

  it("is limited to riders inside the caller's organisation and scope", () => {
    expect(notifications).toContain("current_org_id()");
    expect(notifications).toMatch(/neo_branch_in_scope|organization_id/);
  });
});

describe("roster lifecycle notifications", () => {
  it.each([
    ["enrolment", "delivery.rider.enrol:"],
    ["reinstatement", "delivery.rider.reinstate:"],
    ["retirement", "delivery.rider.retire:"],
    ["a rider-code change", "delivery.rider.code:"],
  ])("notifies the rider on %s under a stable source key", (_label, key) => {
    expect(lifecycleNotify).toContain(key);
    expect(lifecycleNotify).toContain("INSERT INTO public.notifications");
    expect(lifecycleNotify).toMatch(/ON CONFLICT[\s\S]{0,40}DO NOTHING/);
  });

  it("notifies the rider when a shift is scheduled, once per shift", () => {
    expect(shiftNotify).toContain("delivery.rider.shift:");
    expect(shiftNotify).toMatch(/ON CONFLICT[\s\S]{0,40}DO NOTHING/);
  });

  it("refuses to enrol a staff member without the Rider capability", () => {
    expect(enrol).toContain("does not hold a rider capability");
  });

  it("audits retirement with the reason and actor", () => {
    expect(retire).toContain("audit_logs");
    expect(retire).toContain("auth.uid()");
  });
});

describe("registration and role separation", () => {
  it.each([
    "neo_delivery_rider_availability",
    "neo_delivery_rider_notifications",
  ])("%s is registered as authenticated-only", (name) => {
    expect(RPC_MANIFEST[name as keyof typeof RPC_MANIFEST]).toBe("authenticated");
  });

  it("a rider holds no dispatch or roster authority over other riders", () => {
    const riderKey = Object.keys(ROLE_FEATURE_TEMPLATES).find((k) => k.includes("rider"));
    expect(riderKey, "no rider role template").toBeTruthy();
    const grants = compileRoleTemplate(riderKey!, moduleFeatures());
    const flat = JSON.stringify(grants);
    expect(flat).not.toContain("dispatch.assign");
    expect(flat).not.toContain("riders.manage");
  });
});

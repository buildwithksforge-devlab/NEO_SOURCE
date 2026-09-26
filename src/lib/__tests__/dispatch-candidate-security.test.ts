/**
 * Dispatch candidate discovery must be a server-side read.
 *
 * Two halves: the deployed SQL (exported verbatim into
 * `fixtures/dispatch-candidates.sql`) and the client surface, which must never
 * discover or filter riders itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { ROLE_FEATURE_TEMPLATES, compileRoleTemplate } from "@/lib/role-templates";
import { moduleFeatures } from "@/lib/capabilities";

const root = process.cwd();
const SQL = readFileSync(join(root, "src/lib/__tests__/fixtures/dispatch-candidates.sql"), "utf8");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const dispatchCandidates = fn("neo_delivery_dispatch_candidates");
const directory = fn("neo_delivery_rider_directory");
const enrolCandidates = fn("neo_delivery_rider_candidates");
const assign = fn("neo_delivery_assign");

const FEATURES = moduleFeatures();

const deliveryData = read("src/lib/delivery-data.ts");
const dashboard = read("src/routes/_shell.delivery.index.tsx");
const orderSelect = read("src/components/delivery/OrderRiderSelect.tsx");
const shiftsCard = read("src/components/delivery/RiderShiftsCard.tsx");

describe("candidate discovery is refused without dispatch authority", () => {
  it("raises insufficient_privilege rather than returning an empty list", () => {
    for (const [name, body] of [
      ["dispatch candidates", dispatchCandidates],
      ["rider directory", directory],
      ["enrolment candidates", enrolCandidates],
    ] as const) {
      expect(body, name).toContain("insufficient_privilege");
      expect(body, name).toContain("ERRCODE = '42501'");
    }
  });

  it("accepts only the approved dispatch and roster capabilities", () => {
    expect(dispatchCandidates).toContain("has_permission('delivery','dispatch.assign')");
    expect(dispatchCandidates).toContain("has_permission('delivery','riders.manage')");
    expect(directory).toContain("has_permission('delivery','dispatch.assign')");
    expect(directory).toContain("has_permission('delivery','riders.manage')");
    // Enrolment is roster administration, so dispatch alone is not enough.
    expect(enrolCandidates).toContain("has_permission('delivery','riders.manage')");
    expect(enrolCandidates).not.toContain("has_permission('delivery','dispatch.assign')");
  });

  it("grants delivery templates only to delivery roles", () => {
    const deliveryGrants = (role: string) =>
      compileRoleTemplate(role, FEATURES).filter((g) => g.module === "delivery");
    expect(deliveryGrants("delivery-manager").length).toBeGreaterThan(0);
    for (const key of ["waiter", "housekeeper", "receptionist", "storekeeper"]) {
      if (!ROLE_FEATURE_TEMPLATES[key]) continue;
      expect(deliveryGrants(key), key).toEqual([]);
    }
  });

  it("gives a rider self-scoped delivery entry, never approval authority", () => {
    const rider = compileRoleTemplate("rider", FEATURES).filter((g) => g.module === "delivery");
    expect(rider.length).toBeGreaterThan(0);
    expect(rider.some((g) => g.action === "approve" || g.action === "delete")).toBe(false);
  });
});

describe("candidate rows cannot cross a tenant or property boundary", () => {
  it("pins every read to the caller's organisation", () => {
    for (const [name, body] of [
      ["dispatch candidates", dispatchCandidates],
      ["rider directory", directory],
      ["enrolment candidates", enrolCandidates],
    ] as const) {
      expect(body, name).toContain("public.current_org_id()");
      expect(body, name).toContain("organization_id = _org");
      expect(body, name).toContain("IF _org IS NULL THEN RETURN");
    }
  });

  it("filters every candidate row through the caller's property scope", () => {
    expect(dispatchCandidates).toContain("public.neo_branch_in_scope(j.branch_id)");
    expect(directory).toContain("public.neo_branch_in_scope(r.branch_id)");
    expect(enrolCandidates).toContain("public.neo_branch_in_scope(coalesce(e.branch_id, p.branch_id))");
  });

  it("refuses candidates for an order outside the caller's scope", () => {
    expect(dispatchCandidates).toContain("NOT public.neo_branch_in_scope(_o.branch_id)");
    expect(dispatchCandidates).toContain("outside your access scope");
  });

  it("marks riders attached to another property ineligible", () => {
    expect(dispatchCandidates).toContain("Assigned to a different property");
  });
});

describe("inactive and non-rider accounts are excluded", () => {
  it("requires a live staff account holding the rider capability", () => {
    expect(dispatchCandidates).toContain("neo_rider_holds_capability");
    expect(dispatchCandidates).toContain("Staff account is inactive");
    expect(dispatchCandidates).toContain("Staff account does not hold the Rider capability");
    expect(dispatchCandidates).toContain("Retired from the roster");
  });

  it("only offers staff accounts as enrolment candidates", () => {
    expect(enrolCandidates).toContain("coalesce(p.account_type,'staff') = 'staff'");
    expect(enrolCandidates).toContain("coalesce(p.account_status,'active') = 'active'");
    expect(enrolCandidates).toContain("coalesce(p.is_active, true)");
    expect(enrolCandidates).toContain("p.module = 'delivery'");
  });

  it("returns eligibility reasons instead of a silently trimmed list", () => {
    expect(dispatchCandidates).toContain("cardinality(j.why) = 0");
    expect(dispatchCandidates).toContain("Not on an active shift");
    expect(dispatchCandidates).toContain("At the active delivery ceiling");
    expect(dispatchCandidates).toContain("Not cleared to carry cash");
  });
});

describe("candidate payloads stay minimal", () => {
  it("returns no contact details from the rider directory", () => {
    const signature = directory.slice(0, directory.indexOf("AS $function$"));
    for (const leak of ["phone", "email", "national_id", "id_number", "address"]) {
      expect(signature.toLowerCase(), leak).not.toContain(leak);
    }
  });

  it("returns no contact details from enrolment candidates", () => {
    const signature = enrolCandidates.slice(0, enrolCandidates.indexOf("AS $function$"));
    for (const leak of ["phone", "email", "national_id", "address"]) {
      expect(signature.toLowerCase(), leak).not.toContain(leak);
    }
  });
});

describe("the dispatch board uses the server-side candidate source only", () => {
  it("never selects rider_profiles to build a candidate list", () => {
    expect(deliveryData).toContain('guardedRpc(sb, "neo_delivery_rider_directory"');
    expect(deliveryData).toContain('guardedRpc(sb, "neo_delivery_dispatch_candidates"');
    // The only remaining direct reads are a rider's own profile and the
    // roster editor's write path — never a candidate list.
    const directReads = deliveryData.match(/from\("rider_profiles"\)\s*\n?\s*\.select/g) ?? [];
    expect(directReads.length).toBeLessThanOrEqual(1);
    // A rider's own identity comes from the guarded routine, which resolves
    // both a rider's own login and the employee that roster entry belongs to.
    expect(deliveryData).toContain('guardedRpc(sb, "neo_rider_me"');
  });

  it("assigns from the per-order eligibility list, not a client-filtered roster", () => {
    expect(dashboard).toContain("<OrderRiderSelect");
    expect(dashboard).not.toContain('riders.data ?? []).map');
    expect(orderSelect).toContain("useDispatchCandidates");
    expect(orderSelect).not.toContain("rider_profiles");
    // Ineligible riders are shown with the server's reason, never hidden by
    // client-side filtering that could drift from the database rule.
    expect(orderSelect).toContain("disabled={!c.eligible}");
    expect(orderSelect).toContain("c.reasons[0]");
  });

  it("keeps the shift scheduler on the scoped directory", () => {
    expect(shiftsCard).toContain("useRiders");
    expect(shiftsCard).not.toContain("rider_profiles\")");
  });

  it("declares both candidate routines in the RPC manifest", () => {
    expect(RPC_MANIFEST["neo_delivery_dispatch_candidates"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_delivery_rider_directory"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_delivery_rider_candidates"]).toBe("authenticated");
  });
});

describe("assignment after candidate selection", () => {
  it("stays server-side and re-checks eligibility rather than trusting the picker", () => {
    expect(assign).toContain("The delivery.dispatch.assign permission is required.");
    expect(assign).toContain("ERRCODE = '42501'");
    expect(assign).toContain("neo_branch_in_scope");
    // Assignment re-runs the same server-side eligibility routine the picker
    // read, so a stale or forged rider id cannot bypass it.
    expect(assign).toContain("FROM public.neo_delivery_dispatch_candidates(_order)");
    expect(assign).toContain("_cand.eligible IS NOT TRUE");
    expect(deliveryData).toContain('guardedRpc(sb, "neo_delivery_assign"');
  });

  it("requires a reason on reassignment and notifies both riders", () => {
    expect(assign).toContain("reassign");
    expect(assign).toContain("neo_delivery_rider_notify");
  });

  it("surfaces a refusal from the database instead of assuming success", () => {
    expect(deliveryData).toContain('result["ok"] !== true');
    expect(deliveryData).toContain("could not take this order");
  });
});

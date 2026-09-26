/**
 * POS Approvals — end-to-end authority contract.
 *
 * The screen decides voids and refunds, so it is gated three times: the route
 * capability opens the page, and each decision button has its own action gate.
 * This suite drives the *real* permission resolver (`canFromPermissions`, the
 * same function `useAuth().can` is built from) and the real route capability
 * table against realistic permission sets, one per role, and asserts every
 * approvals flow separately.
 *
 * Note on naming: `pos.approvals.decide` is the spoken POS decision authority
 * and is an alias onto the catalogued `restaurant.approvals.approve` (with
 * `void.approve` / `refunds.approve` for the per-decision gates). Treating
 * `decide` as a *separate* permission is what once locked every legitimate
 * approver, Owner included, out of the screen; the alias plus the mapping
 * validator is what prevents that returning.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { capabilitiesForPath, capabilityForPath, capabilityKey, pathPermitted } from "@/lib/capabilities";
import { canFromPermissions, featureKey, permissionKey } from "@/lib/permissions";
import {
  CapabilityMappingError,
  POS_APPROVAL_CAPABILITY_MAP,
  resolveCapability,
  resolvePosApprovalGates,
  validateCapabilityMappings,
} from "@/lib/pos-approvals-authority";

const route = readFileSync("src/routes/_shell.pos.approvals.tsx", "utf8");

const PATH = "/pos/approvals";

/** Everything the screen asks, expressed exactly as the component asks it. */
function gates(granted: string[]) {
  const set = new Set(granted);
  const can = canFromPermissions(set);
  return {
    canOpenPage: pathPermitted(can, PATH),
    ...resolvePosApprovalGates(can),
  };
}

describe("permission-mapping validator", () => {
  it("maps every POS approval capability onto a catalogued permission", () => {
    expect(POS_APPROVAL_CAPABILITY_MAP).toEqual({
      "pos.approvals.decide": "restaurant.approvals.approve",
      "pos.void.approve": "restaurant.void.approve",
      "pos.refunds.approve": "restaurant.refunds.approve",
    });
  });

  it("fails fast on a capability that maps to no real module", () => {
    expect(() => resolveCapability("pretend-module.approvals.decide")).toThrow(
      CapabilityMappingError,
    );
    expect(() => validateCapabilityMappings(["approvals"])).toThrow(CapabilityMappingError);
  });
});


const OWNER = [featureKey("restaurant", "*", "approve"), featureKey("restaurant", "*", "view")];
const FNB_MANAGER = [
  featureKey("restaurant", "approvals", "approve"),
  featureKey("restaurant", "orders", "view"),
];
const VOID_ONLY = [
  featureKey("restaurant", "approvals", "approve"),
  featureKey("restaurant", "void", "approve"),
];
const CASHIER = [
  featureKey("restaurant", "orders", "create"),
  featureKey("restaurant", "orders", "view"),
];

describe("Owner / Director", () => {
  const g = gates(OWNER);

  it("opens the approvals page", () => expect(g.canOpenPage).toBe(true));
  it("can decide the void flow", () => expect(g.canDecideVoid).toBe(true));
  it("can decide the refund flow", () => expect(g.canDecideRefund).toBe(true));

  it("resolves through module-wide approval authority, not a role name", () => {
    expect(gates([permissionKey("restaurant", "approve")]).canDecideVoid).toBe(true);
    expect(gates([permissionKey("restaurant", "approve")]).canDecideRefund).toBe(true);
  });
});

describe("F&B manager holding approvals.approve", () => {
  const g = gates(FNB_MANAGER);
  it("opens the page and decides both flows", () => {
    expect(g.canOpenPage).toBe(true);
    expect(g.canDecideVoid).toBe(true);
    expect(g.canDecideRefund).toBe(true);
  });
});

describe("supervisor with a narrowed decision grant", () => {
  const g = gates(VOID_ONLY);
  it("opens the page", () => expect(g.canOpenPage).toBe(true));
  it("decides voids", () => expect(g.canDecideVoid).toBe(true));
  it("also decides refunds only because approvals.approve is module approval authority", () => {
    // Documented reality: `approvals.approve` IS the POS approval authority.
    // Narrowing to voids alone means withholding it and granting `void.approve`.
    expect(g.canDecideRefund).toBe(true);

    const narrowed = gates([featureKey("restaurant", "void", "approve")]);
    expect(narrowed.canDecideVoid).toBe(true);
    expect(narrowed.canDecideRefund).toBe(false);
  });
});

describe("cashier and other unprivileged staff", () => {
  const g = gates(CASHIER);
  it("cannot open the page", () => expect(g.canOpenPage).toBe(false));
  it("cannot decide either flow", () => {
    expect(g.canDecideVoid).toBe(false);
    expect(g.canDecideRefund).toBe(false);
  });
  it("holds nothing when granted no permissions at all", () => {
    const none = gates([]);
    expect(none.canOpenPage).toBe(false);
    expect(none.canDecideVoid).toBe(false);
    expect(none.canDecideRefund).toBe(false);
  });
});

describe("the route capability itself", () => {
  it("is restaurant.approvals.approve", () => {
    expect(capabilityKey(capabilityForPath(PATH)!)).toBe("restaurant.approvals.approve");
  });

  it("is what the spoken `pos.approvals.decide` capability resolves to", () => {
    expect(POS_APPROVAL_CAPABILITY_MAP["pos.approvals.decide"]).toBe(
      "restaurant.approvals.approve",
    );
  });
});

describe("the screen never re-introduces phantom permissions", () => {
  it("checks only catalogued POS authorities", () => {
    // The screen no longer hand-rolls its checks: it goes through the single
    // validated gating helper, so it cannot drift from route guard or RLS.
    expect(route).toContain("resolvePosApprovalGates(can)");
    const code = route.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toContain("orders.approve");
  });

  it("gates the decision buttons, not just the page", () => {
    expect(route).toContain("canDecideVoid");
    expect(route).toContain("canDecideRefund");
    expect(route).toMatch(/status === "pending" && canDecideVoid/);
    expect(route).toMatch(/status === "pending" && canDecideRefund/);
  });
});

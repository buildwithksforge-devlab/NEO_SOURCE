import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addGrant, canExactlyFromPermissions, canFromPermissions } from "@/lib/permissions";

/**
 * End-to-end kitchen authority: a chef executes the work in front of them —
 * accept, start preparing, update progress, mark ready — and is refused the
 * allocation of work to themselves or to anybody else.
 *
 * The two evaluators below mirror the deployed database guards exactly:
 *
 *   neo_can_assign_kitchen_work() -> is_org_admin_for(current_org_id())
 *                                    OR has_exact_permission('kitchen', …,
 *                                       'chef.assign' | 'item.reassign'
 *                                       | 'production.manage')
 *
 *   neo_kitchen_item_transition() -> has_permission('kitchen', <action>)
 *                                    where accepted -> ticket.accept,
 *                                    preparing -> item.prepare,
 *                                    ready -> item.ready, else item.prepare
 *
 * so a permission model change that unlocks self-assignment, or that locks a
 * chef out of execution, fails here before it can reach a live kitchen.
 */
type Grant = [string, string, string];

const grants = (rows: Grant[]) => {
  const set = new Set<string>();
  for (const [module, feature, action] of rows) addGrant(set, module, feature, action);
  return set;
};

const HEAD_CHEF = grants([
  ["kitchen", "*", "chef.assign"],
  ["kitchen", "*", "item.reassign"],
  ["kitchen", "*", "production.manage"],
  ["kitchen", "*", "all_stations.view"],
  ["kitchen", "ticket", "accept"],
  ["kitchen", "item", "prepare"],
  ["kitchen", "item", "ready"],
]);
const KITCHEN_MANAGER = grants([
  ["kitchen", "*", "production.manage"],
  ["kitchen", "queue", "view"],
  ["kitchen", "ticket", "accept"],
  ["kitchen", "item", "prepare"],
  ["kitchen", "item", "ready"],
]);
const STATION_CHEF = grants([
  ["kitchen", "*", "create"],
  ["kitchen", "*", "edit"],
  ["kitchen", "queue", "view"],
  ["kitchen", "ticket", "accept"],
  ["kitchen", "item", "prepare"],
  ["kitchen", "item", "ready"],
]);
const BARISTA = grants([
  ["kitchen", "queue", "view"],
  ["kitchen", "ticket", "accept"],
  ["kitchen", "item", "prepare"],
  ["kitchen", "item", "ready"],
]);
const FNB_MANAGER = grants([["kitchen", "*", "all_stations.view"]]);
const WAITER = grants([["pos", "orders", "create"]]);

/** Mirrors neo_can_assign_kitchen_work() for a non-administrator session. */
function canAllocate(perms: Set<string>) {
  const exact = canExactlyFromPermissions(perms);
  return (
    exact("kitchen", "chef.assign") ||
    exact("kitchen", "chef", "assign") ||
    exact("kitchen", "item.reassign") ||
    exact("kitchen", "item", "reassign") ||
    exact("kitchen", "production.manage") ||
    exact("kitchen", "production", "manage")
  );
}

/** Mirrors the permission branch of neo_kitchen_item_transition(). */
const TRANSITION_PERMISSION: Record<string, string> = {
  accepted: "ticket.accept",
  preparing: "item.prepare",
  progress: "item.prepare",
  ready: "item.ready",
};

function canTransition(perms: Set<string>, to: string) {
  const can = canFromPermissions(perms);
  return can("kitchen", TRANSITION_PERMISSION[to] ?? "item.prepare");
}

const EXECUTION_FLOW = ["accepted", "preparing", "progress", "ready"] as const;

describe("a chef executes assigned kitchen work end to end", () => {
  for (const [name, perms] of [
    ["station chef", STATION_CHEF],
    ["barista", BARISTA],
    ["head chef", HEAD_CHEF],
    ["kitchen manager", KITCHEN_MANAGER],
  ] as const) {
    it(`lets a ${name} accept, start, update and mark ready`, () => {
      for (const step of EXECUTION_FLOW) {
        expect(canTransition(perms, step), `${name} must be able to move a ticket to ${step}`).toBe(
          true,
        );
      }
    });
  }

  it("refuses the whole execution flow to a waiter", () => {
    for (const step of EXECUTION_FLOW) {
      expect(canTransition(WAITER, step)).toBe(false);
    }
  });
});

describe("allocation of kitchen work stays with kitchen management", () => {
  it("blocks self-assignment and reassignment for ordinary kitchen staff", () => {
    expect(canAllocate(STATION_CHEF)).toBe(false);
    expect(canAllocate(BARISTA)).toBe(false);
    expect(canAllocate(WAITER)).toBe(false);
    // Supervisory visibility alone is never allocation authority.
    expect(canAllocate(FNB_MANAGER)).toBe(false);
  });

  it("allows allocation for the head chef and the kitchen manager", () => {
    expect(canAllocate(HEAD_CHEF)).toBe(true);
    expect(canAllocate(KITCHEN_MANAGER)).toBe(true);
  });

  it("keeps execution authority even where allocation is denied", () => {
    expect(canAllocate(STATION_CHEF)).toBe(false);
    expect(canTransition(STATION_CHEF, "accepted")).toBe(true);
    expect(canTransition(STATION_CHEF, "ready")).toBe(true);
  });

  it("does not let a chef's broad kitchen grants satisfy the strict gate", () => {
    expect(canFromPermissions(STATION_CHEF)("kitchen", "chef.assign")).toBe(true);
    expect(canExactlyFromPermissions(STATION_CHEF)("kitchen", "chef.assign")).toBe(false);
  });
});

describe("the client cannot route around the backend gate", () => {
  const data = readFileSync("src/lib/kitchen-data.ts", "utf8");

  it("allocates only through the governed routine, executes through the transition RPC", () => {
    expect(data).toContain("neo_kitchen_assign_chef");
    expect(data).toContain("kitchen_item_transition");
    expect(data).not.toContain("assigned_chef_id");
  });
});

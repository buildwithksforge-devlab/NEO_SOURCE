import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addGrant, canExactlyFromPermissions, canFromPermissions } from "@/lib/permissions";

/**
 * Allocation of kitchen work belongs to kitchen management. Chefs see the
 * shared queue and execute the work in front of them, but they cannot hand
 * work to themselves or move it between colleagues.
 */
const grants = (rows: Array<[string, string | null, string]>) => {
  const set = new Set<string>();
  for (const [module, feature, action] of rows) addGrant(set, module, feature, action);
  return set;
};

// Mirrors the live role templates.
const HEAD_CHEF = grants([
  ["kitchen", "*", "chef.assign"],
  ["kitchen", "*", "item.reassign"],
  ["kitchen", "*", "production.manage"],
  ["kitchen", "*", "all_stations.view"],
]);
const CHEF = grants([
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

const allocates = (perms: Set<string>) => {
  const canExact = canExactlyFromPermissions(perms);
  return (
    canExact("kitchen", "chef.assign") ||
    canExact("kitchen", "item.reassign") ||
    canExact("kitchen", "production.manage")
  );
};

describe("kitchen allocation authority", () => {
  it("grants allocation to kitchen management only", () => {
    expect(allocates(HEAD_CHEF)).toBe(true);
    expect(allocates(CHEF)).toBe(false);
    expect(allocates(BARISTA)).toBe(false);
    expect(allocates(FNB_MANAGER)).toBe(false);
    expect(allocates(WAITER)).toBe(false);
  });

  it("does not let a chef's broad kitchen edit grant stand in for allocation", () => {
    // The lenient check matches by action class, which is exactly why the
    // allocation gate uses the strict one on both sides of the wire.
    expect(canFromPermissions(CHEF)("kitchen", "chef.assign")).toBe(true);
    expect(canExactlyFromPermissions(CHEF)("kitchen", "chef.assign")).toBe(false);
  });

  it("leaves execution actions with the chefs", () => {
    const chef = canFromPermissions(CHEF);
    expect(chef("kitchen", "ticket.accept")).toBe(true);
    expect(chef("kitchen", "item.prepare")).toBe(true);
    expect(chef("kitchen", "item.ready")).toBe(true);
    const barista = canFromPermissions(BARISTA);
    expect(barista("kitchen", "ticket.accept")).toBe(true);
    expect(barista("kitchen", "item.ready")).toBe(true);
  });
});

describe("kitchen queue client never writes allocation columns directly", () => {
  const data = readFileSync("src/lib/kitchen-data.ts", "utf8");
  const queue = readFileSync("src/routes/_shell.kitchen.queue.tsx", "utf8");

  it("assigns through the governed routine", () => {
    expect(data).toContain("neo_kitchen_assign_chef");
    expect(data).not.toContain("assigned_chef_id");
    expect(data).not.toMatch(/from\("ticket_assignments"\)\s*\.insert/);
  });

  it("hides allocation controls without the explicit authority", () => {
    expect(queue).toContain("canExact(\"kitchen\", \"chef.assign\")");
    expect(queue).toContain("{canAllocate ?");
  });
});

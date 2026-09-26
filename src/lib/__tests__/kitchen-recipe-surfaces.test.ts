/**
 * Recipe / menu authoring surfaces are supervisory.
 *
 * Kitchen Manager and Head Chef may open and edit recipe and menu screens;
 * a line chef and a waiter may not — and the sidebar decision matches the route
 * guard exactly in both directions, so nothing is visible-but-denied or
 * hidden-but-reachable.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canAccessPath, navItemVisible, type CanFn } from "@/lib/nav-permissions";
import { addGrant, canFromPermissions } from "@/lib/permissions";

type Grant = [string, string, string];

function canFor(grants: Grant[]): CanFn {
  const set = new Set<string>();
  for (const [module, feature, action] of grants) addGrant(set, module, feature, action);
  return canFromPermissions(set);
}

/** Head Chef / Kitchen Manager hold the whole kitchen module (kitchen.*). */
const KITCHEN_MANAGER: Grant[] = [
  ["kitchen", "*", "view"],
  ["kitchen", "*", "edit"],
  ["kitchen", "*", "create"],
  ["kitchen", "*", "recipes.view"],
  ["kitchen", "*", "recipes.create"],
  ["kitchen", "*", "recipes.approve"],
  ["restaurant", "menu", "view"],
  ["restaurant", "menu", "edit"],
];

/** A line chef executes assigned production only. */
const LINE_CHEF: Grant[] = [
  ["kitchen", "overview", "view"],
  ["kitchen", "*", "assigned.view"],
  ["kitchen", "*", "item.start"],
  ["kitchen", "*", "item.ready"],
];

/** A waiter sees service state, never production standards. */
const WAITER: Grant[] = [
  ["pos", "*", "view"],
  ["restaurant", "orders", "view"],
  ["kitchen", "*", "assigned.view"],
];

const RECIPE_PATH = "/kitchen/recipes";

describe("recipe screen access by role", () => {
  it("kitchen manager / head chef may open recipes", () => {
    expect(canAccessPath(canFor(KITCHEN_MANAGER), RECIPE_PATH)).toBe(true);
  });

  it("line chef may not open recipes", () => {
    expect(canAccessPath(canFor(LINE_CHEF), RECIPE_PATH)).toBe(false);
  });

  it("waiter may not open recipes", () => {
    expect(canAccessPath(canFor(WAITER), RECIPE_PATH)).toBe(false);
  });
});

describe("sidebar matches the route guard", () => {
  for (const [label, grants, expected] of [
    ["kitchen manager", KITCHEN_MANAGER, true],
    ["line chef", LINE_CHEF, false],
    ["waiter", WAITER, false],
  ] as [string, Grant[], boolean][]) {
    it(`${label}: nav visibility and route access agree (${expected})`, () => {
      const can = canFor(grants);
      expect(navItemVisible(can, RECIPE_PATH)).toBe(expected);
      expect(canAccessPath(can, RECIPE_PATH)).toBe(expected);
    });
  }

  it("the recipe screen is reachable from the sidebar, not URL-only", () => {
    const nav = readFileSync("src/lib/navigation.ts", "utf8");
    expect(nav).toContain('to: "/kitchen/recipes"');
  });
});

describe("in-page recipe write actions carry their own precise gates", () => {
  const source = readFileSync("src/routes/_shell.kitchen.recipes.tsx", "utf8");

  it("reads behind a kitchen recipes.view guard", () => {
    expect(source).toContain('<KitchenGuard action="recipes.view">');
  });

  it("creating a recipe requires recipes.create, approving requires recipes.approve", () => {
    expect(source).toContain('can("kitchen", "recipes.create")');
    expect(source).toContain('can("kitchen", "recipes.approve")');
  });

  it("never falls back to a bare module-wide manage check", () => {
    expect(source).not.toMatch(/can\("kitchen",\s*"manage"\)/);
  });
});

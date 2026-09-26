// @vitest-environment jsdom
/**
 * Assets & Equipment register.
 *
 * The register must render as its own page, expose exactly the status
 * vocabulary enforced by the `assets_status_check` database constraint, and
 * must never reach into the consumable stock module — assets and consumable
 * inventory (`stock_items`) are deliberately separate registers.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { capabilityForPath } from "@/lib/capabilities";
import { isAssetStatusTransitionAllowed } from "@/lib/operations";

const routeSource = readFileSync("src/routes/_shell.assets.tsx", "utf8");
const opsSource = readFileSync("src/lib/operations.ts", "utf8");
const categoriesSource = readFileSync("src/routes/admin.asset-categories.tsx", "utf8");

/**
 * The asset permission vocabulary that actually exists in the catalogue. A
 * surface gated on anything outside this list is invisible to every account,
 * including the owner — which is exactly how the category page was lost.
 */
const ASSET_ACTIONS = ["view", "manage", "transfer"];

const DB_ASSET_STATUSES = [
  "active",
  "in-storage",
  "assigned",
  "under-maintenance",
  "out-of-service",
  "lost",
  "disposed",
  "sold",
  "retired",
];

describe("Assets & Equipment register", () => {
  it("declares its own route and head metadata at /assets", () => {
    expect(routeSource).toContain('createFileRoute("/_shell/assets")');
    expect(routeSource).toContain("Assets & Equipment — NEØ");
    expect(routeSource).toContain('property: "og:title"');
    expect(routeSource).toContain('property: "og:description"');
    expect(routeSource).toContain('property: "og:type"');
    expect(routeSource).toContain('name: "twitter:card"');
  });

  it("is gated behind the maintenance module", () => {
    expect(routeSource).toMatch(/<OpsGuard module="maintenance"/);
  });

  it("is built from the catalogue workspace primitives", () => {
    expect(routeSource).toContain("<CatalogueWorkspace");
    expect(routeSource).toContain("<SummaryStrip");
    expect(routeSource).toContain("<InspectorSheet");
  });

  it("supports add, edit, transfer and status-change actions", () => {
    expect(routeSource).toContain("New asset");
    expect(routeSource).toContain("Edit asset");
    expect(routeSource).toContain("Transfer / assign");
    expect(routeSource).toContain("Change status");
    expect(routeSource).toMatch(/useMoveAsset/);
    expect(routeSource).toMatch(/useSetAssetStatus/);
    expect(routeSource).toMatch(/useSaveAsset/);
  });

  it("notes that depreciation/asset accounting is a future Finance extension", () => {
    expect(routeSource.toLowerCase()).toContain("depreciation");
    expect(routeSource.toLowerCase()).toContain("finance");
  });

  it("the ASSET_STATUSES vocabulary matches the database CHECK constraint exactly", () => {
    const match = opsSource.match(/export const ASSET_STATUSES = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const values = [...(match![1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(values).toEqual(DB_ASSET_STATUSES);
  });

  it("the register consumes ASSET_STATUSES for its status options", () => {
    expect(routeSource).toContain("ASSET_STATUSES.map");
    expect(routeSource).toContain("ASSET_CONDITIONS.map");
  });

  it("never queries stock_items — consumable inventory stays a separate register", () => {
    expect(routeSource).not.toMatch(/stock_items/);
  });
  it("gates the category configuration page on a permission that actually exists", () => {
    const capability = capabilityForPath("/admin/asset-categories");
    expect(capability?.module).toBe("maintenance");
    expect(capability?.feature).toBe("assets");
    expect(ASSET_ACTIONS).toContain(capability?.action ?? "view");
  });

  it("separates viewing from managing and transferring on the register", () => {
    expect(routeSource).toContain('can("maintenance", "assets", "manage")');
    expect(routeSource).toContain('can("maintenance", "assets", "transfer")');
    expect(routeSource).not.toContain('can("maintenance", "assets.edit")');
  });

  it("edits the categories through the canonical asset_categories collection only", () => {
    expect(categoriesSource).toContain('table="asset_categories"');
    expect(categoriesSource).toContain('can("maintenance", "assets", "manage")');
  });

  it("keeps a disposed, sold or retired asset out of service", () => {
    expect(isAssetStatusTransitionAllowed("active", "disposed")).toBe(true);
    expect(isAssetStatusTransitionAllowed("disposed", "active")).toBe(false);
    expect(isAssetStatusTransitionAllowed("sold", "in-storage")).toBe(false);
    expect(isAssetStatusTransitionAllowed("retired", "retired")).toBe(true);
    // Found property is a real outcome, so "lost" is recoverable.
    expect(isAssetStatusTransitionAllowed("lost", "active")).toBe(true);
  });

  it("records every asset change in the audit trail", () => {
    const data = readFileSync("src/lib/operations-data.ts", "utf8");
    for (const action of ["asset.registered", "asset.updated", "asset.moved", "asset.status_changed"]) {
      expect(data).toContain(action);
    }
  });

  it("does not truncate a full legacy register", () => {
    const data = readFileSync("src/lib/operations-data.ts", "utf8");
    const assetsQuery = data.slice(data.indexOf("export function useAssets()"));
    expect(assetsQuery.slice(0, 1400)).toContain(".limit(5000)");
  });
});

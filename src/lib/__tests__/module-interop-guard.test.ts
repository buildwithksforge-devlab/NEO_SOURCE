/**
 * Module-load interop guard.
 *
 * A dependency graph that resolves two majors of a TypeScript runtime shim
 * (tslib) crashed the whole app at module load with
 *   "Cannot destructure property '__extends' of '__toESM(...).default'"
 * while every unit test stayed green, because Vitest resolves ESM entry points
 * differently from the production bundler.
 *
 * These checks fail fast on the dependency shape that causes that class of
 * crash, and exercise the static bundle scanner used by `bun run smoke`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM build script, no type declarations
import { findBrokenInteropDestructures } from "../../../scripts/build-smoke.mjs";

const ROOT = process.cwd();

function pkg(): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

describe("tslib resolves to a single ESM-safe version", () => {
  it("pins one tslib major for every dependency", () => {
    const p = pkg();
    expect(p["overrides"]?.["tslib"]).toBeDefined();
    expect(p["overrides"]?.["tslib"]).toMatch(/^\^?2\./);
    expect(p["resolutions"]?.["tslib"]).toBe(p["overrides"]?.["tslib"]);
  });

  it("has no nested tslib copy that could shadow the pinned one", () => {
    const modules = path.join(ROOT, "node_modules");
    const packages = readdirSync(modules, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const packageDirs = packages.flatMap((entry) => {
      const dir = path.join(modules, entry.name);
      return entry.name.startsWith("@")
        ? readdirSync(dir, { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => path.join(dir, child.name))
        : [dir];
    });
    const nested = packageDirs.filter((dir) => existsSync(path.join(dir, "node_modules", "tslib")));
    expect(nested).toEqual([]);
  });

  it("installs a tslib whose ESM entry exports helpers directly", () => {
    const dir = path.join(ROOT, "node_modules", "tslib");
    const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version as string;
    expect(Number(version.split(".")[0])).toBeGreaterThanOrEqual(2);

    const esm = path.join(dir, "tslib.es6.mjs");
    if (existsSync(esm)) {
      const source = readFileSync(esm, "utf8");
      // tslib 1.x destructured a default import; tslib 2.x exports each helper.
      expect(source).not.toMatch(/\}\s*=\s*tslib\s*;/);
      expect(source).toMatch(/export\s+function\s+__extends/);
    }
  });
});

describe("bundle interop scanner", () => {
  it("flags a destructure of a CommonJS default that yields undefined helpers", () => {
    const broken = 'var { __extends, __assign } = (/* @__PURE__ */ __toESM(requireTslib()));';
    expect(findBrokenInteropDestructures(broken)).toContain("__extends");
  });

  it("ignores ordinary destructuring and plain named imports", () => {
    expect(findBrokenInteropDestructures('const { data, error } = await q;')).toEqual([]);
    expect(findBrokenInteropDestructures('import { __extends } from "./tslib.es6.mjs";')).toEqual([]);
  });
});

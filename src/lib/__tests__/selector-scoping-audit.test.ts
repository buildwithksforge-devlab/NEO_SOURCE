/**
 * Repo-level guard for the global scoping contract.
 *
 * Every relational selector (worker, department, station) must be sourced from
 * the shared scoped catalogue in `src/lib/scoped-options.ts`, so a branch-scoped
 * operator is never offered another property's records. This test fails when a
 * new selector reads the raw catalogues directly.
 *
 * The allow-list holds the deliberate exceptions: organisation-wide admin
 * catalogues, server functions, identity reads and the preview simulator.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src");

const ALLOWED = new Set([
  // Admin catalogue management — these screens exist to curate every record.
  "src/routes/_shell.departments.tsx",
  "src/routes/_shell.stations.tsx",
  "src/lib/access-matrix.ts",
  "src/lib/workspace-preview-data.ts",
  // Identity / own-record reads, not selectors.
  "src/lib/auth.tsx",
  "src/lib/tenant-store.ts",
  "src/lib/visibility.ts",
  "src/routes/auth.tsx",
  "src/routes/auth.reset-password.tsx",
  "src/routes/_shell.profile.tsx",
  "src/routes/rider.profile.tsx",
  "src/routes/admin.ai-simulator.tsx",
  // HR record management reads employees with its own explicit filters.
  "src/lib/hr-data.ts",
  // Payroll enrolment and onboarding are organisation-wide HR administration:
  // they must see every employee record in the workspace, not a property slice.
  "src/lib/hr-payroll.ts",
  "src/routes/_shell.hr.onboarding.tsx",
  // Station reads that already narrow on the active property inline.
  "src/lib/kitchen-data.ts",
  "src/lib/kitchen-tickets.ts",
  "src/lib/pos-data.ts",
  // Bar scope resolution: reads its own stations/departments with an inline
  // active-property filter to narrow shared F&B lists to the Bar.
  "src/lib/bar.ts",
  // User directory: the administration surface listing every account it may manage.
  "src/routes/_shell.users.tsx",
]);

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const CATALOGUE = /\.from\(\s*"(profiles|departments|operational_stations|employees)"\s*\)/;

describe("global selector scoping", () => {
  const files = walk(ROOT).filter(
    (f) => !f.endsWith(".server.ts") && !f.endsWith(".functions.ts"),
  );

  it("keeps every relational selector on the shared scoped catalogue", () => {
    const offenders = files
      .map((f) => ({ rel: f.slice(process.cwd().length + 1).replace(/\\/g, "/"), body: readFileSync(f, "utf8") }))
      .filter((f) => CATALOGUE.test(f.body))
      .map((f) => f.rel)
      .filter((rel) => !ALLOWED.has(rel));

    expect(offenders).toEqual([]);
  });

  it("exposes the scoped catalogue hooks the modules depend on", () => {
    const body = readFileSync(join(ROOT, "lib", "scoped-options.ts"), "utf8");
    for (const hook of [
      "useScopedDepartments",
      "useScopedStations",
      "useScopedWorkers",
      "useScopedWorkerOptions",
      "useScopedDepartmentByKey",
    ]) {
      expect(body).toContain(`export function ${hook}`);
    }
  });
});

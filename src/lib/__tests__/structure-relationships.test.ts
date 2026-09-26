/**
 * Structural contract: Organisation → Property → Department → Role → Worker →
 * Station → resource/transaction.
 *
 * Channel: read-only SQL (PG* environment). These assertions prove the chain has
 * no duplicates, no orphan records and no wrong-property relationships, and that
 * the database refuses to create new ones.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

function count(query: string): number {
  const out = execFileSync("psql", ["-At", "-c", query], { encoding: "utf8" });
  return Number(out.trim() || "0");
}

describe.runIf(HAS_SQL)("hierarchy has no duplicates", () => {
  it("has one active property per name and one main property per organisation", () => {
    expect(
      count(`SELECT count(*) FROM (
               SELECT 1 FROM branches WHERE active
                GROUP BY organization_id, lower(btrim(name)) HAVING count(*) > 1) x`),
    ).toBe(0);
    expect(
      count(`SELECT count(*) FROM (
               SELECT 1 FROM branches WHERE active AND is_main
                GROUP BY organization_id HAVING count(*) > 1) x`),
    ).toBe(0);
  });

  it("has one active department name per property and one active role per catalogue key", () => {
    expect(
      count(`SELECT count(*) FROM (
               SELECT 1 FROM departments WHERE department_status = 'active'
                GROUP BY organization_id, branch_id, lower(btrim(name)) HAVING count(*) > 1) x`),
    ).toBe(0);
    expect(
      count(`SELECT count(*) FROM (
               SELECT 1 FROM roles
                WHERE normalized_role_key IS NOT NULL AND coalesce(role_status,'active') = 'active'
                GROUP BY organization_id, normalized_role_key HAVING count(*) > 1) x`),
    ).toBe(0);
  });

  it("has one staff identifier and one employee number per organisation", () => {
    expect(
      count(`SELECT count(*) FROM (
               SELECT 1 FROM profiles WHERE coalesce(btrim(staff_id),'') <> ''
                GROUP BY organization_id, upper(btrim(staff_id)) HAVING count(*) > 1) x`),
    ).toBe(0);
    expect(
      count(`SELECT count(*) FROM (
               SELECT 1 FROM employees WHERE coalesce(btrim(employee_number),'') <> ''
                GROUP BY organization_id, upper(btrim(employee_number)) HAVING count(*) > 1) x`),
    ).toBe(0);
  });
});

describe.runIf(HAS_SQL)("hierarchy has no orphans or wrong-property links", () => {
  it("keeps every department, role and store inside its own organisation and property", () => {
    expect(
      count(`SELECT count(*) FROM departments d LEFT JOIN branches b ON b.id = d.branch_id
              WHERE d.branch_id IS NOT NULL AND (b.id IS NULL OR b.organization_id <> d.organization_id)`),
    ).toBe(0);
    expect(
      count(`SELECT count(*) FROM roles r LEFT JOIN departments d ON d.id = r.department_id
              WHERE r.department_id IS NOT NULL AND (d.id IS NULL OR d.organization_id <> r.organization_id)`),
    ).toBe(0);
    expect(
      count(`SELECT count(*) FROM stock_locations l JOIN departments d ON d.id = l.department_id
              WHERE l.branch_id IS NOT NULL AND d.branch_id IS NOT NULL AND d.branch_id <> l.branch_id`),
    ).toBe(0);
  });

  it("keeps workers, employees and stations inside a single property", () => {
    expect(
      count(`SELECT count(*) FROM profiles p JOIN departments d ON d.id = p.department_id
              WHERE p.branch_id IS NOT NULL AND d.branch_id IS NOT NULL AND d.branch_id <> p.branch_id`),
    ).toBe(0);
    expect(
      count(`SELECT count(*) FROM employees e
               LEFT JOIN departments d ON d.id = e.department_id
               LEFT JOIN operational_stations s ON s.id = e.station_id
              WHERE e.branch_id IS NOT NULL
                AND ((d.branch_id IS NOT NULL AND d.branch_id <> e.branch_id)
                  OR (s.branch_id IS NOT NULL AND s.branch_id <> e.branch_id))`),
    ).toBe(0);
    expect(
      count(`SELECT count(*) FROM operational_stations s JOIN departments d ON d.id = s.department_id
              WHERE s.branch_id IS NOT NULL AND d.branch_id IS NOT NULL AND d.branch_id <> s.branch_id`),
    ).toBe(0);
    expect(
      count(`SELECT count(*) FROM user_stations us JOIN operational_stations s ON s.id = us.station_id
              WHERE us.branch_id IS NOT NULL AND s.branch_id IS NOT NULL AND s.branch_id <> us.branch_id`),
    ).toBe(0);
  });

  it("leaves no role assignment without a role in the same organisation", () => {
    expect(
      count(`SELECT count(*) FROM user_roles ur LEFT JOIN roles r ON r.id = ur.role_id
              WHERE r.id IS NULL OR r.organization_id <> ur.organization_id`),
    ).toBe(0);
  });
});

describe.runIf(HAS_SQL)("the database refuses new structural breaks", () => {
  it("guards every level of the chain with the structure trigger", () => {
    const guarded = execFileSync(
      "psql",
      [
        "-At",
        "-c",
        `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE t.tgname = 'trg_neo_structure_guard' ORDER BY 1`,
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(guarded).toEqual([
      "departments",
      "employees",
      "operational_stations",
      "profiles",
      "roles",
      "stock_locations",
      "user_stations",
    ]);
  });

  it("exposes a repeatable structure scan and a property merge that retires, never deletes", () => {
    expect(count(`SELECT count(*) FROM pg_proc WHERE proname = 'neo_structure_scan'`)).toBe(1);
    const src = execFileSync("psql", ["-At", "-c", `SELECT prosrc FROM pg_proc WHERE proname = 'neo_merge_branch'`], {
      encoding: "utf8",
    });
    expect(src).toContain("UPDATE public.branches");
    expect(src).not.toMatch(/DELETE\s+FROM\s+public\.branches/i);
  });
});

describe("no tenant-specific logic is hardcoded", () => {
  it("keeps demo tenant identifiers out of shipped source", () => {
    const scan = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.name === "__tests__") return [];
      if (entry.isDirectory()) return scan(file);
      return /\.tsx?$/.test(entry.name) && /savannah|aa17d427-f816-49bc-b02e-1a89e44806a2/i.test(readFileSync(file, "utf8")) ? [file] : [];
    });
    expect(scan("src")).toEqual([]);
  });
});

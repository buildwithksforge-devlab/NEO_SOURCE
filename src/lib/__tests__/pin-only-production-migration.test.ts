import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/20261030180000_neo_pin_only_display.sql";
const disabledPath = `${migrationPath}.disabled`;
const sql = readFileSync(migrationPath, "utf8");

describe("PIN-only production display migration", () => {
  it("ships as an enabled migration", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(existsSync(disabledPath)).toBe(false);
  });

  it("requires a unique active personal PIN within the organisation", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toMatch(
      /existing\.organization_id\s*=\s*v_org[\s\S]*existing\.user_id\s*<>\s*auth\.uid\(\)[\s\S]*crypt\(_pin,\s*existing\.pin_hash\)/,
    );
    expect(sql).toContain("This PIN is unavailable. Choose another six-digit PIN.");
  });

  it("resolves exactly one employee without requiring a staff code", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.neo_production_display_act_pin_only",
    );
    expect(sql).toMatch(/v_matches\s*<>\s*1/);
    expect(sql).toContain("PIN not accepted. Check your PIN or ask your supervisor.");
  });

  it("delegates station permission, transition and audit checks to the existing action routine", () => {
    expect(sql).toContain("public.neo_production_display_act(");
    expect(sql).toContain("TO anon, authenticated");
  });
});
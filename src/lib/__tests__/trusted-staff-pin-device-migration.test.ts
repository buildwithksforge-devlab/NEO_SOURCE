import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20261031230000_trusted_staff_pin_devices.sql",
  "utf8",
);

describe("trusted staff PIN devices", () => {
  it("stores only a device-token hash and keeps the table private", () => {
    expect(sql).toContain("token_hash text NOT NULL UNIQUE");
    expect(sql).not.toMatch(/device_token text/i);
    expect(sql).toMatch(
      /REVOKE ALL ON public\.neo_staff_login_devices\s+FROM PUBLIC, anon, authenticated/,
    );
  });

  it("allows only workforce-authorised staff to pair or revoke a device", () => {
    expect(sql).toContain("public.can_manage_workforce()");
    expect(sql).toContain("public.neo_branch_in_scope(_branch)");
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.neo_staff_login_device_pair\(uuid, text\)\s+TO authenticated/,
    );
  });

  it("keeps PIN resolution service-role only", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.neo_staff_login_device_resolve\(text, text\)\s+FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.neo_staff_login_device_resolve\(text, text\)\s+TO service_role/,
    );
  });

  it("requires exactly one PIN owner inside the device organisation", () => {
    expect(sql).toMatch(
      /c\.organization_id\s*=\s*v_device\.organization_id[\s\S]*c\.enabled\s*=\s*true[\s\S]*crypt\(_pin,\s*c\.pin_hash\)/,
    );
    expect(sql).toMatch(/v_matches\s*<>\s*1/);
  });

  it("checks the employee under their own identity and restores server identity", () => {
    expect(sql).toContain("public.neo_production_context(v_user)");
    expect(sql).toContain("public.is_active_staff()");
    expect(sql).toContain(
      "public.neo_branch_in_scope(v_device.branch_id)",
    );
    expect(sql).toContain(
      "current_setting('request.jwt.claims', true)",
    );
    expect(sql).toContain("public.neo_access_cache_bump()");
  });

  it("rate-limits failed PIN attempts without returning email or staff code", () => {
    expect(sql).toContain("v_device.failed_attempts + 1 >= 5");
    expect(sql).toContain("interval '15 minutes'");
    expect(sql).not.toMatch(/jsonb_build_object\([^;]*(email|staff_code)/i);
  });
});
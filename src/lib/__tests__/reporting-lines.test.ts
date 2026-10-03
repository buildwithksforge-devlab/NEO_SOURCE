import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RPC_MANIFEST } from "../rpc-manifest";

const usersRoute = readFileSync("src/routes/_shell.users.tsx", "utf8");
const usersFns = readFileSync("src/lib/users.functions.ts", "utf8");

/**
 * The reporting line is an authoritative record: staff account ids and
 * canonical role keys only. These tests fail the build if the interface ever
 * goes back to guessing managers from names, job titles or employee rows.
 */
describe("reporting lines", () => {
  it("resolves eligible managers from the catalogue RPC, not a local list", () => {
    expect(usersRoute).toContain("neo_reporting_candidates");
    expect(usersRoute).not.toContain('from("employees")');
  });

  it("re-resolves candidates whenever roles, department or property change", () => {
    expect(usersRoute).toMatch(/queryKey: \[\s*"reporting-candidates",/);
    expect(usersRoute).toContain("current?.role_ids");
    expect(usersRoute).toContain("current?.branch_id");
    expect(usersRoute).toContain("current?.department_id");
  });

  it("stores the line on the staff account and refuses self-reporting", () => {
    expect(usersFns).toContain("reporting_manager_id: newManagerId");
    expect(usersFns).toContain("An employee cannot report to themselves");
  });

  it("only accepts a manager the candidate resolver returned", () => {
    expect(usersFns).toContain("neo_reporting_candidates");
    expect(usersFns).toMatch(/not eligible for this employee/);
  });

  it("flags an unset but required reporting line for review", () => {
    expect(usersFns).toContain("neo_role_reporting_meta");
    expect(usersFns).toContain("assignment_review_required");
  });

  it("declares both reporting routines in the callable manifest", () => {
    expect(RPC_MANIFEST["neo_reporting_candidates"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_role_reporting_meta"]).toBe("authenticated");
  });

  it("keeps reporting lines separate from capability enforcement", () => {
    expect(usersFns).toContain('requireCapability(supabase, "users", "edit")');
  });

  it("records the reporting line when the account is first created", () => {
    expect(usersFns).toContain("reporting_manager_profile_id?: string | null");
    expect(usersFns).toContain('"neo_provision_worker"');
    expect(usersFns).toContain("reporting_manager_profile_id:");
    expect(usersRoute).toMatch(/queryKey: \[\s*"reporting-candidates",\s*"new-user"/);
  });

  it("clears a manager the new assignment no longer permits", () => {
    expect(usersRoute).toContain("managerStillEligible");
    expect(usersRoute).toContain("reporting_manager_profile_id: \"\"");
  });
});


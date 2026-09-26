import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "../rpc-manifest";

/**
 * HR directory reconciliation contract.
 *
 * The organisation's people already exist as staff accounts with roles. HR was
 * skeletal only because nothing ever turned those accounts into employee
 * records. `neo_hr_reconcile_staff` closes that gap, and it must do so without
 * ever inventing employment facts: dates, contracts, grades, salaries and
 * reporting lines stay blank so HR completes them deliberately.
 */
const URL = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];
const KEY = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];

describe("HR reconciliation contract", () => {
  it("declares the routine on the authenticated callable surface", () => {
    expect(RPC_MANIFEST["neo_hr_reconcile_staff"]).toBe("authenticated");
  });

  it.runIf(URL && KEY)("refuses a signed-out caller", async () => {
    const anon = createClient(URL!, KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("neo_hr_reconcile_staff", { _commit: false });
    expect(error, "an anonymous caller must never reconcile the HR directory").not.toBeNull();
  });
});

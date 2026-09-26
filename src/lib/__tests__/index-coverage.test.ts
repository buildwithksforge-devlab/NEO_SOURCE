import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "../rpc-manifest";

/**
 * Tenant-scale indexing contract.
 *
 * At 10,000 organisations, an operational table without an index led by
 * organization_id degrades into a sequential scan of every tenant's rows.
 * `neo_index_class` is the canonical classification (A high-volume feed,
 * B filtered work queue, C master data, D configuration, E child/line table
 * read through its parent, F platform catalogue) and
 * `neo_index_coverage_scan` must stay empty: every class A and B table carries
 * an index whose leading column is organization_id.
 *
 * This is the standing guard. A new tenant-keyed operational table that ships
 * without its index fails here rather than at 100 million rows.
 */
const URL = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];
const KEY = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];

describe("tenant-scale index coverage", () => {
  it("declares both checks on the authenticated callable surface", () => {
    expect(RPC_MANIFEST["neo_index_class"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_index_coverage_scan"]).toBe("authenticated");
  });

  it.runIf(URL && KEY)("refuses a signed-out caller", async () => {
    const anon = createClient(URL!, KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("neo_index_coverage_scan");
    expect(error, "schema introspection must never be anonymous").not.toBeNull();
  });
});

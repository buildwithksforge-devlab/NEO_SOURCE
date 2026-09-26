import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RPC_MANIFEST } from "../rpc-manifest";

const SRC = join(process.cwd(), "src");
const SKIP = new Set(["integrations", "__tests__"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function callSites(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf8");
    // Client calls go through `guardedRpc(client, "name")` or the `callRpc`
    // helper; token-authenticated server routes use `trustedRpc`. All
    // forms are call sites, and the name may sit on the next line when the
    // call is wrapped by the formatter.
    for (const match of source.matchAll(
      /\b(?:rpc|callRpc|guardedRpc|trustedRpc)\s*(?:<[\s\S]*?>)?\(\s*(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)?"([a-z0-9_]+)"/g,
    )) {
      const name = match[1]!;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
  }
  return found;
}

describe("database callable surface", () => {
  const sites = callSites();
  // The QA simulation harness runs server-side against throwaway TEST
  // workspaces and deliberately exercises restricted posting routines that the
  // app itself must never call from a browser. Those are not part of the
  // application's callable surface, so they are judged by their own contract
  // test rather than the manifest.
  const appSites = [...sites.entries()].filter(
    ([, files]) => !files.every((f) => f.includes(join("lib", "simulation"))),
  );

  it("declares every routine the application calls", () => {
    const undeclared = appSites
      .map(([name]) => name)
      .filter((name) => !(name in RPC_MANIFEST))
      .sort();
    expect(undeclared, "add these to RPC_MANIFEST with the role that must execute them").toEqual(
      [],
    );
  });


  // Guard routines exist for the contract tests and for operators; they are
  // deliberately never called from application code, but they are part of the
  // callable surface and must still declare who may execute them.
  const GUARD_ROUTINES = new Set([
    "neo_index_class",
    "neo_index_coverage_scan",
    "neo_rbac_model_health",
  ]);

  it("does not keep manifest entries with no remaining call site", () => {
    const orphaned = Object.keys(RPC_MANIFEST)
      .filter((name) => !sites.has(name) && !GUARD_ROUTINES.has(name))
      .sort();
    expect(orphaned, "remove stale entries so the manifest stays truthful").toEqual([]);
  });

  it("exposes only the published storefront menu to signed-out callers", () => {
    const anon = Object.entries(RPC_MANIFEST)
      .filter(([, caller]) => caller === "anon")
      .map(([name]) => name)
      .sort();
    // Workspace lookup is resolved by the trusted server client. The only
    // routine a signed-out visitor may run is the published menu listing, so
    // the Guest and Delivery storefronts render before an account exists; it
    // returns published, available items only and no cost, guest or staff data.
    // The branded property entrance is the other deliberate exception: it
    // resolves a hotel's public name, city and logo for its own sign-in page
    // and grants nothing — membership and permissions are decided after login.
    // The NEØ front door adds the public hotel list, a hotel's public page and
    // its entrance states: published information only, granting nothing.
    expect(anon).toEqual([
      "neo_property_doors",
      "neo_property_entrance",
      "neo_public_destinations",
      "neo_public_directory",
      "neo_public_experiences",
      "neo_public_menu",
      "neo_public_property",
      "neo_public_property_rooms",
      "neo_track_entry",
    ]);
    expect(RPC_MANIFEST["resolve_public_workspace"]).toBe("service_role");
  });
});

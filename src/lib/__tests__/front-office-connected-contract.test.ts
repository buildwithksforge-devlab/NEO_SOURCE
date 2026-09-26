import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260924153000_front_office_connected_guards.sql"),
  "utf8",
);
const waitlistRoute = readFileSync(resolve(root, "src/routes/_shell.pms.waitlist.tsx"), "utf8");
const groupsRoute = readFileSync(resolve(root, "src/routes/_shell.pms.groups.tsx"), "utf8");
const ops = readFileSync(resolve(root, "src/lib/frontdesk-ops.ts"), "utf8");
const manifest = readFileSync(resolve(root, "src/lib/rpc-manifest.ts"), "utf8");

describe("connected Front Office certification guards", () => {
  it("keeps checked-in Guest requests attached to reservation, stay and room", () => {
    expect(migration).toContain("'checked-in'");
    expect(migration).toContain("stay_id");
    expect(migration).toContain("res.stay_id");
  });

  it("keeps Guest room-offer pricing aligned with inclusive rate plans", () => {
    expect(migration).toContain("tax_treatment");
    expect(migration).toContain("lower(COALESCE(p.tax_treatment,'exclusive')) = 'exclusive'");
  });

  it("permits only the controlled minibar workflow to perform its downstream stock/folio posting", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.neo_minibar_post");
    expect(migration).toContain("set_config('neo.system_posting', 'on', true)");
    expect(migration).toContain("set_config('neo.system_posting', 'off', true)");
  });

  it("lets the Front Office requisition capability reach the department requisition RPC", () => {
    expect(migration).toContain("has_permission('pms','requisitions.create')");
  });

  it("uses UUID source_record_id and the partial idempotency index predicate for group deposits", () => {
    expect(migration).toContain("'pms.groups', _group, _idem");
    expect(migration).toContain("ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING");
  });

  it("adds real create actions for waitlist and groups instead of empty management-only screens", () => {
    expect(waitlistRoute).toContain("Add to waitlist");
    expect(groupsRoute).toContain("New group");
    expect(ops).toContain('"pms_waitlist_create"');
    expect(ops).toContain('"pms_group_create"');
    expect(manifest).toContain("pms_waitlist_create");
    expect(manifest).toContain("pms_group_create");
  });
});

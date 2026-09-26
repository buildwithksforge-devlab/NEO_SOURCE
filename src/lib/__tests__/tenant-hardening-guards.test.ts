/**
 * Standing guards for the coordinated tenancy hardening programme.
 *
 * Channel: read-only SQL (PG* environment). These assert the guarantees that
 * must survive every future change:
 *
 *  1. Multi-group identity: one person may hold memberships in several
 *     workspaces, but context always resolves to exactly one active workspace.
 *  2. Privileged surface: every SECURITY DEFINER routine is classified, and no
 *     routine trusts a workspace identifier supplied by the caller unless it is
 *     a deliberate public-portal surface.
 *  3. Relationship integrity: cross-workspace links are blocked going forward
 *     and every pre-existing exception stays recorded rather than silently
 *     repaired.
 *  4. Provisioning: workspace creation is idempotent and template-based.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

function sql(query: string): string[][] {
  const out = execFileSync("psql", ["-At", "-F", "\u0001", "-c", query], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\u0001"));
}

function one(query: string): string {
  return sql(query)[0]?.[0] ?? "";
}

/** Whole-value read for multi-line results such as a routine definition. */
function text(query: string): string {
  return execFileSync("psql", ["-At", "-c", query], { encoding: "utf8" });
}

/**
 * Public-portal routines addressed by workspace on purpose: a guest arrives
 * with a workspace identifier and a booking or order reference, with no
 * session to derive context from. Each returns only that guest's own record or
 * publicly published information.
 */
const PUBLIC_WORKSPACE_ADDRESSED = new Set([
  "neo_public_menu",
  "neo_property_entrance",
  "neo_guest_active_stay",
  "neo_guest_deposit_pay",
  "neo_guest_order_tracking",
  "neo_guest_reservation_position",
  "neo_guest_room_offers",
]);

describe.runIf(HAS_SQL)("multi-group identity resolves to one active workspace", () => {
  it("keeps one membership row per person per workspace", () => {
    expect(
      one(`SELECT count(*) FROM (
             SELECT 1 FROM public.organization_memberships
              GROUP BY user_id, organization_id HAVING count(*) > 1) d`),
    ).toBe("0");
  });

  it("never leaves an active workspace the person is not a member of", () => {
    expect(
      one(`SELECT count(*) FROM public.profiles p
            WHERE p.active_organization_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.organization_memberships m
                 WHERE m.user_id = p.id
                   AND m.organization_id = p.active_organization_id
                   AND m.status = 'active')`),
    ).toBe("0");
  });

  it("derives context from membership rather than a single stored workspace", () => {
    const def = text(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'current_org_id'`);
    expect(def).toMatch(/organization_memberships/i);
    expect(def).toMatch(/active_organization_id/i);
  });

  it("restricts property access to the active workspace", () => {
    const def = text(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'current_branch_ids'`);
    expect(def).toMatch(/current_org_id/i);
  });
});

describe.runIf(HAS_SQL)("the privileged surface stays classified and minimal", () => {
  it("classifies every privileged routine", () => {
    expect(
      one(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosecdef
              AND NOT EXISTS (
                SELECT 1 FROM public.privileged_function_review r
                 WHERE r.function_name = p.proname
                   AND r.identity_arguments = pg_get_function_identity_arguments(p.oid))`),
    ).toBe("0");
  });

  it("trusts a caller-supplied workspace only on deliberate public surfaces", () => {
    const trusting = sql(
      `SELECT function_name FROM public.privileged_function_review WHERE trusts_client_tenant ORDER BY 1`,
    ).map((r) => r[0] ?? "");
    expect(trusting.filter((n) => !PUBLIC_WORKSPACE_ADDRESSED.has(n))).toEqual([]);
  });

  it("keeps workspace provisioning off the directly callable surface", () => {
    expect(
      one(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'provision_catalogue_roles'
              AND (has_function_privilege('authenticated', p.oid, 'execute')
                OR has_function_privilege('anon', p.oid, 'execute'))`),
    ).toBe("0");
  });
});

describe.runIf(HAS_SQL)("relationship integrity is enforced and exceptions are recorded", () => {
  it("guards critical relationships with a workspace check", () => {
    const guards = Number(
      one(`SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE NOT t.tgisinternal AND p.proname = 'neo_assert_tenant_fk'`),
    );
    expect(guards).toBeGreaterThan(200);
  });

  it("keeps every pre-existing cross-workspace link on the register instead of repairing it blindly", () => {
    const open = Number(one(`SELECT count(*) FROM public.tenant_relationship_violations`));
    expect(open).toBeGreaterThan(0);
    expect(
      one(`SELECT count(*) FROM public.tenant_relationship_violations WHERE child_table IS NULL OR child_id IS NULL`),
    ).toBe("0");
  });
});

describe.runIf(HAS_SQL)("workspace provisioning is deterministic", () => {
  it("records a restartable run keyed for idempotency", () => {
    const def = text(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'bootstrap_tenant_for'`);
    expect(def).toMatch(/provisioning_runs/i);
    expect(def).toMatch(/idempotency_key/i);
    expect(def).toMatch(/organization_memberships/i);
    expect(def).toMatch(/tenant_lifecycle_states/i);
  });

  it("inherits role templates instead of copying permission rows", () => {
    const def = text(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'bootstrap_tenant_for'`);
    expect(def).toMatch(/follows_template/i);
    expect(def).not.toMatch(/INSERT INTO public\.role_permissions/i);
  });
});

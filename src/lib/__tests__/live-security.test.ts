/**
 * Live security tests against the connected project database.
 *
 * These run for real — they are not fixture assertions. Two channels are used:
 *   1. a read-only SQL connection (PG* environment) for catalogue inspection
 *      (RLS state, policies, routine grants, search_path pinning);
 *   2. the public Data API with the publishable key, to prove the anonymous
 *      boundary actually refuses privileged routines and tenant tables.
 *
 * No privileged secret is read, printed or bundled here: the service-role key
 * is never touched, and the optional signed-in session token is only ever put
 * in an Authorization header, never asserted on or logged.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);
const API_URL = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];
const ANON_KEY = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
const HAS_API = Boolean(API_URL && ANON_KEY);
const SESSION_TOKEN = process.env["LOVABLE_BROWSER_SUPABASE_ACCESS_TOKEN"];

function sql(query: string): string[][] {
  const out = execFileSync("psql", ["-At", "-F", "\u0001", "-c", query], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\u0001"));
}

async function rest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("apikey", ANON_KEY!);
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${API_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Routines the anonymous role must never be able to execute. */
const PRIVILEGED_RPCS = [
  "neo_delivery_dispatch_candidates",
  "neo_delivery_rider_directory",
  "neo_delivery_rider_candidates",
  "neo_delivery_assign",
  "neo_delivery_notification_audit",
  "neo_stores_receive_goods",
  "neo_pos_send_to_kitchen",
  "neo_provision_worker",
  "my_effective_access",
];

/** Tenant tables that must be unreadable without a session. */
const TENANT_TABLES = [
  "rider_profiles",
  "delivery_orders",
  "customers",
  "profiles",
  "user_roles",
  "goods_receipts",
  "folios",
  "attendance_records",
];

describe("live environment", () => {
  it("has the read-only SQL channel and the public Data API configured", () => {
    expect(
      { sql: HAS_SQL, api: HAS_API },
      "live security tests need PGHOST plus SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY",
    ).toEqual({ sql: true, api: true });
  });
});

describe.runIf(HAS_SQL)("live database — RLS and tenant isolation", () => {
  it("keeps row level security enabled on every tenant table under test", () => {
    const rows = sql(`
      SELECT c.relname, c.relrowsecurity::text
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname IN (${TENANT_TABLES.map((t) => `'${t}'`).join(",")})
       ORDER BY 1`);
    expect(rows.length).toBe(TENANT_TABLES.length);
    expect(rows.filter(([, on]) => on !== "true" && on !== "t").map(([t]) => t)).toEqual([]);
  });

  it("gives every RLS-enabled public table a policy, or keeps it off the Data API", () => {
    const rows = sql(`
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
       ORDER BY 1`);
    // RLS on with no policy means nothing is readable. That is only acceptable
    // for internal tables reached solely through SECURITY DEFINER routines, so
    // each one must also carry no Data API grant at all.
    const exposed = sql(`
      SELECT DISTINCT table_name FROM information_schema.role_table_grants
       WHERE table_schema = 'public'
         AND grantee IN ('anon','authenticated')
         AND table_name IN (${rows.map(([t]) => `'${t}'`).join(",") || "''"})
       ORDER BY 1`);
    expect(exposed.map(([t]) => t)).toEqual([]);
  });

  it("scopes tenant tables by organisation in their policies", () => {
    const rows = sql(`
      SELECT c.relname, count(*) FILTER (
               WHERE pg_get_expr(p.polqual, p.polrelid) ILIKE '%organization_id%'
                  OR pg_get_expr(p.polqual, p.polrelid) ILIKE '%current_org%'
                  OR pg_get_expr(p.polqual, p.polrelid) ILIKE '%in_my_scope%'
                  OR pg_get_expr(p.polqual, p.polrelid) ILIKE '%auth.uid()%')::text
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_policy p ON p.polrelid = c.oid
       WHERE n.nspname = 'public'
         AND c.relname IN (${TENANT_TABLES.map((t) => `'${t}'`).join(",")})
       GROUP BY 1 ORDER BY 1`);
    expect(rows.filter(([, n]) => Number(n) === 0).map(([t]) => t)).toEqual([]);
  });
});

describe.runIf(HAS_SQL)("live database — privileged routine boundaries", () => {
  /**
   * The single deliberately anonymous, read-only storefront routine. It returns
   * only published, available menu items (name, description, price) for one
   * organisation and never touches recipes, costs, guests or staff. The Guest
   * and Delivery apps must render for a signed-out visitor, so the exception is
   * named here rather than left as an unexplained linter warning. The modifier
   * lookup is signed-in only — it already required a session internally, so its
   * anonymous EXECUTE grant was revoked.
   */
  /**
   * The branded property entrance: a hotel's own sign-in page must show that
   * hotel's name, city and logo before anyone has signed in. It grants no
   * access — membership, property assignment and permissions are decided
   * only after sign-in, by a signed-in-only routine.
   */
  // The NEØ front door adds three deliberate signed-out reads: the public
  // hotel list, one hotel's public page, and which entrances that hotel has
  // switched on. They publish only what the hotel chose to publish and grant
  // nothing — who may actually walk through an entrance is resolved after
  // sign-in from that person's real relationship with the hotel.
  const PUBLIC_STOREFRONT_ROUTINES = [
    "neo_property_entrance",
    "neo_public_menu",
    "neo_public_directory",
    "neo_public_property",
    "neo_property_doors",
  ];

  it("never grants EXECUTE on a SECURITY DEFINER routine to PUBLIC or anon", () => {
    const rows = sql(`
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND (p.proacl IS NULL
              OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                          WHERE a.privilege_type = 'EXECUTE'
                            AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)))
       ORDER BY 1`);
    const unexpected = rows
      .map(([f]) => f!)
      .filter((f) => !PUBLIC_STOREFRONT_ROUTINES.includes(f));
    expect(unexpected).toEqual([]);
  });

  it("never grants PUBLIC (not merely anon) execute on the storefront routines", () => {
    const rows = sql(`
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (${PUBLIC_STOREFRONT_ROUTINES.map((r) => `'${r}'`).join(",")})
         AND (p.proacl IS NULL
              OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                          WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0))
       ORDER BY 1`);
    expect(rows.map(([f]) => f)).toEqual([]);
  });


  it("pins search_path on every SECURITY DEFINER routine", () => {
    const rows = sql(`
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                          WHERE c LIKE 'search_path=%')
       ORDER BY 1`);
    expect(rows.map(([f]) => f)).toEqual([]);
  });

  it("guards dispatch candidate discovery with a capability check and property scope", () => {
    const body = sql(`SELECT replace(prosrc, chr(10), ' ') FROM pg_proc WHERE proname = 'neo_delivery_dispatch_candidates'`)[0]?.[0] ?? "";
    expect(body).toContain("dispatch.assign");
    expect(body).toContain("insufficient_privilege");
    expect(body).toContain("neo_branch_in_scope");
    expect(body).toContain("neo_rider_holds_capability");
  });

  it("guards rider directory and enrolment candidate discovery the same way", () => {
    for (const fn of ["neo_delivery_rider_directory", "neo_delivery_rider_candidates"]) {
      const body = sql(`SELECT replace(prosrc, chr(10), ' ') FROM pg_proc WHERE proname = '${fn}'`)[0]?.[0] ?? "";
      expect(body, fn).toContain("insufficient_privilege");
      expect(body, fn).toContain("neo_branch_in_scope");
      expect(body, fn).toContain("current_org_id()");
    }
  });

  it("exposes exactly one overload of each dispatch and receiving routine", () => {
    const rows = sql(`
      SELECT proname, count(*)::text FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND proname IN ('neo_delivery_dispatch_candidates','neo_delivery_rider_directory',
                         'neo_delivery_rider_candidates','neo_delivery_assign',
                         'neo_delivery_rider_notify','neo_stores_receive_goods',
                         'neo_pos_send_to_kitchen')
       GROUP BY 1 ORDER BY 1`);
    expect(rows.filter(([, n]) => Number(n) !== 1)).toEqual([]);
  });

  it("keeps void/discount governance and GRN over-receipt enforced by triggers", () => {
    const rows = sql(`
      SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgfoid::regproc::text IN ('neo_pos_guard_void_discount','neo_grn_guard_over_receipt')
       ORDER BY 1`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe.runIf(HAS_API)("live Data API — anonymous boundary", () => {
  it("refuses every privileged RPC without a session", async () => {
    const results: Record<string, number> = {};
    for (const fn of PRIVILEGED_RPCS) {
      const { status } = await rest(`rpc/${fn}`, { method: "POST", body: "{}" });
      results[fn] = status;
    }
    // 401/403 = denied outright, 404 = not exposed. Never 200.
    expect(Object.entries(results).filter(([, s]) => s === 200)).toEqual([]);
  }, 30_000);

  it("returns no rider candidates to an anonymous caller", async () => {
    const { status, body } = await rest("rpc/neo_delivery_dispatch_candidates", {
      method: "POST",
      body: JSON.stringify({ _order: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(status).toBe(401);
    expect(JSON.stringify(body)).toContain("permission denied");
  });

  it("leaks no rows from tenant tables to an anonymous caller", async () => {
    const leaks: string[] = [];
    for (const table of TENANT_TABLES) {
      const { status, body } = await rest(`${table}?select=id&limit=1`);
      if (status === 200 && Array.isArray(body) && body.length > 0) leaks.push(table);
    }
    expect(leaks).toEqual([]);
  }, 30_000);

  it("rejects a forged bearer token", async () => {
    const { status } = await rest("rider_profiles?select=id&limit=1", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect([401, 403]).toContain(status);
  });
});

describe.runIf(HAS_API && Boolean(SESSION_TOKEN))("live Data API — signed-in caller", () => {
  it("scopes rider directory results to the caller's own organisation", async () => {
    const { status, body } = await rest("rpc/neo_delivery_rider_directory", {
      method: "POST",
      body: JSON.stringify({ _branch: null }),
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });
    // Either the caller holds dispatch authority (200 + scoped rows) or the
    // database refuses them. A signed-in caller must never get another
    // tenant's riders, so an empty or denied response is equally correct.
    expect([200, 401, 403]).toContain(status);
    if (status === 200) {
      expect(Array.isArray(body)).toBe(true);
      const rows = body as Array<Record<string, unknown>>;
      // Minimal projection: no contact details or staff PII in the payload.
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(
          [
            "active",
            "active_load",
            "availability_status",
            "branch_id",
            "display_name",
            "max_active",
            "on_shift",
            "rider_code",
            "rider_id",
            "vehicle_type",
          ].sort(),
        );
      }
    }
  }, 20_000);
});

/**
 * Events read models must obey the caller's property scope, not just the
 * workspace. A branch-scoped coordinator viewing "All Properties" must never
 * see, count, or be graded on another property's events.
 */
describe("events property scoping (live)", () => {
  it.skipIf(!HAS_SQL)("filters every events read model by the caller's properties", () => {
    for (const routine of ["neo_event_workspace", "events_metrics", "events_department_readiness", "neo_event_billing"]) {
      const def = sql(
        `SELECT replace(pg_get_functiondef(oid), chr(10), ' ') FROM pg_proc WHERE proname = '${routine}' AND pronamespace = 'public'::regnamespace`,
      )
        .map((r) => r[0] ?? "")
        .join(" ");
      expect(def.length, `${routine} must exist`).toBeGreaterThan(0);
      expect(def, `${routine} must apply neo_branch_in_scope`).toContain("neo_branch_in_scope");
      expect(def, `${routine} must scope to the workspace`).toContain("current_org_id()");
    }
  });

  it.skipIf(!HAS_SQL)("never lets an event exist without a property", () => {
    const [row] = sql(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='event_bookings' AND column_name='branch_id'",
    );
    expect(row?.[0]).toBe("NO");
  });
});

describe.runIf(HAS_SQL)("live database — guest CRM activity is capability gated", () => {
  it("does not let any staff account read customer digital activity", () => {
    const rows = sql(`
      SELECT replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), chr(10), ' ')
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'customer_digital_events'
         AND p.polname = 'Staff read digital activity in their organisation'`);
    const qual = rows[0]?.[0] ?? "";
    expect(qual, "policy missing").not.toBe("");
    expect(qual).toContain("current_org_id()");
    // Org membership alone is not enough: a CRM/guest capability is required.
    expect(qual).toContain("has_permission");
    expect(qual).toContain("'customers'");
  });
});

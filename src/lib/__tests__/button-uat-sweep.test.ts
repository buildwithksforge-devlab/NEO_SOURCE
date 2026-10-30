import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityForPath } from "@/lib/capabilities";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

/**
 * Button-by-button UAT sweep.
 *
 * Every visible control that mutates, prints or exports must be:
 *  - gated (route capability or an in-page `can()` check),
 *  - wired to a real mutation / RPC / table write,
 *  - followed by a cache refresh so the screen reflects the write,
 *  - scoped to the selected property when it creates property-owned records,
 *  - pointed at the real document engine when it prints or exports.
 *
 * These are static contract checks: they pin the visible action to its handler
 * so a control cannot silently become decorative.
 */

const ROUTES = "src/routes";

function routeFiles(): string[] {
  return readdirSync(ROUTES).filter((f) => f.endsWith(".tsx") && f !== "__root.tsx");
}

function read(file: string): string {
  return readFileSync(join(ROUTES, file), "utf8");
}

function pathFor(file: string): string {
  const p = file
    .replace(/^_shell/, "")
    .replace(/\.tsx$/, "")
    .replace(/\./g, "/")
    .replace(/\/index$/, "")
    .replace(/\/\$\w+/g, "/x");
  return p === "" ? "/" : p;
}

const actionable = routeFiles().filter((f) => /onClick=\{|onSelect=\{/.test(read(f)));
const mutating = actionable.filter((f) => /useMutation|useServerFn/.test(read(f)));

/**
 * Self-service surfaces every signed-in worker may open: their own approvals,
 * notifications, tasks, engagement, profile and HR self record. These are
 * intentionally not capability-gated; the rows themselves are self-scoped.
 */
const SELF_SERVICE = new Set([
  "/approvals",
  "/notifications",
  "/tasks",
  "/my-engagement",
  "/profile",
  "/hr/me",
]);

describe("button-by-button UAT — visibility gates", () => {
  it("resolves a registered capability for every actionable module route", () => {
    const ungated = actionable
      .filter((f) => f.startsWith("_shell."))
      .map(pathFor)
      .filter((p) => !SELF_SERVICE.has(p) && capabilityForPath(p) === null)
      .sort();
    expect(ungated, "every module screen with buttons must resolve a capability").toEqual([]);
  });

  it("keeps the self-service allowlist to genuinely personal surfaces", () => {
    for (const p of SELF_SERVICE) {
      expect(capabilityForPath(p), `${p} must stay universal`).toBeNull();
    }
  });
});

describe("button-by-button UAT — mutation wiring", () => {
  it("keeps shared KDS mutations connected to the token-scoped RPC", () => {
    const screen = readFileSync("src/routes/station-screen.tsx", "utf8");
    const helper = readFileSync("src/lib/shared-production-display.ts", "utf8");
    const manifest = readFileSync("src/lib/rpc-manifest.ts", "utf8");
    const sql = readFileSync(
      "supabase/migrations/20261021110000_shared_production_displays.sql",
      "utf8",
    );

    expect(screen).toMatch(/mutationFn:[\s\S]{0,350}actOnSharedDisplay\(/);
    expect(helper).toMatch(
      /guardedRpc<DisplayActionResult>\(\s*supabase,\s*"neo_production_display_act"/,
    );
    expect(helper).toContain("_token: token");
    expect(helper).toContain("_pin: pin");
    expect(manifest).toMatch(/neo_production_display_act:\s*"anon"/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.neo_production_display_act\([^)]*\) TO anon, authenticated;/,
    );
  });
  it("never ships a mutating screen without a real write path", () => {
    const dead = mutating
      .filter((f) => {
        const s = read(f);
        return !/supabase\s*\.|rpc\(|guardedRpc(?:<[^>]+>)?\s*\(|trustedRpc\(|from\("|useServerFn|-data"|\.functions"|actOnSharedDisplay\s*\(/.test(s);
      })
      .sort();
    expect(dead, "these screens have mutations with no data path").toEqual([]);
  });

  it("refreshes cached data after every inline route mutation", () => {
    const stale = mutating
      .filter((f) => {
        const s = read(f);
        if (!/useMutation\(/.test(s)) return false;
        return !/invalidateQueries|invalidate\(|refetch\(/.test(s);
      })
      .sort();
    expect(stale, "a mutation without invalidation leaves the screen stale").toEqual([]);
  });

  it("refreshes cached data after every shared data-layer mutation", () => {
    const libs = readdirSync("src/lib").filter((f) => f.endsWith("-data.ts"));
    const stale = libs.filter((f) => {
      const s = readFileSync(join("src/lib", f), "utf8");
      return /useMutation/.test(s) && !/invalidateQueries/.test(s);
    });
    expect(stale).toEqual([]);
  });
});

describe("button-by-button UAT — print and export actions", () => {
  it("routes every print/export control through the branded document engine", () => {
    const offenders = routeFiles()
      .filter((f) => {
        const s = read(f);
        if (!/Print|Export|Download/.test(s)) return false;
        return /href="#"/.test(s) || /window\.print\(\)/.test(s);
      })
      .sort();
    expect(offenders, "print/export must not be a placeholder link").toEqual([]);
  });

  it("keeps the document payload routine registered for authenticated callers", () => {
    expect(RPC_MANIFEST["neo_document_payload"]).toBe("authenticated");
  });
});

describe("button-by-button UAT — property scoping of creation actions", () => {
  it("creates reservations against the selected property, not the clerk's home branch", () => {
    const s = read("_shell.pms.reservations.new.tsx");
    expect(s).toContain("useActivePropertyFilter");
    expect(s).toContain("const branchId = activeBranchId ?? profile?.branch_id");
    // Creating a booking must refresh the arrival/reservation surfaces.
    expect(s).toContain("invalidateQueries");
  });
});

/**
 * Family pins — each remaining visible action family must reach a real handler.
 * The pin names the file and the write it performs, so deleting or unwiring the
 * control fails here rather than in production.
 */
const MUTATES = /useMutation|\.mutate\(|\.mutateAsync\(/;
const MUTATES_OR_EXPORT = /useMutation|\.mutate\(|Export|Print/;

const FAMILY_PINS: Array<[string, string, RegExp[]]> = [
  ["Laundry — receive/return linen", "_shell.laundry.batches.tsx", [MUTATES, /can\(/]],
  ["Laundry — incidents", "_shell.laundry.incidents.tsx", [MUTATES, /can\(/]],
  ["Laundry — my work", "_shell.laundry.my-work.tsx", [MUTATES]],
  ["Housekeeping — board", "_shell.housekeeping.board.tsx", [MUTATES]],
  ["Housekeeping — inspections", "_shell.housekeeping.inspections.tsx", [MUTATES]],
  ["Housekeeping — tasks", "_shell.housekeeping.tasks.tsx", [MUTATES, /can\(/]],
  ["Maintenance — work orders", "_shell.maintenance.index.tsx", [MUTATES, /can\(/]],
  ["Maintenance — my jobs", "_shell.maintenance.my-jobs.tsx", [MUTATES]],
  ["Front office — arrivals", "_shell.pms.arrivals.tsx", [/MovementBoard scope="arrivals"/, /PmsGuard action="arrivals\.view"/]],
  ["Front office — departures", "_shell.pms.departures.tsx", [/MovementBoard scope="departures"/, /PmsGuard action="departures\.view"/]],
  ["Folio detail", "_shell.pms.folios.$id.tsx", [MUTATES]],
  ["Finance — journals", "_shell.finance.journals.tsx", [MUTATES]],
  ["Finance — posting", "_shell.finance.posting.tsx", [MUTATES, /can\(/]],
  ["Finance — till", "_shell.finance.till.tsx", [MUTATES]],
  // Collections folded into the canonical cashier queue; the redirect route holds no handler.
  ["Finance — cashier queue", "_shell.finance.queue.tsx", [MUTATES, /can\(/]],
  ["CRM — customers", "_shell.crm.customers.index.tsx", [/neo_customer_resolve/, /customer_consents/]],
  ["CRM — duplicates", "_shell.crm.duplicates.tsx", [/useMergeDuplicate/, /useReviewDuplicate/]],
  ["Marketing — campaigns", "_shell.marketing.campaigns.tsx", [MUTATES, /can\(/]],
  ["Marketing — leads", "_shell.marketing.leads.tsx", [MUTATES, /can\(/]],
  ["HR — leave", "_shell.hr.leave.tsx", [MUTATES, /can\(/]],
  ["HR — attendance", "_shell.hr.attendance.tsx", [MUTATES, /can\(/]],
  ["HR — employees", "_shell.hr.employees.index.tsx", [MUTATES, /can\(/]],
  ["Tasks", "_shell.tasks.tsx", [MUTATES]],
  ["Notifications", "_shell.notifications.tsx", [MUTATES]],
  ["Automation — rules", "_shell.automation.rules.tsx", [/task_assignment_rules/, /escalation_policies/, /notification_rules/]],
  ["Automation — failures", "_shell.automation.failures.tsx", [/retry\(\{ data: \{ failureId/, /refresh\(\)/, /can\(/]],
  ["Analytics", "_shell.analytics.index.tsx", [MUTATES_OR_EXPORT]],
  ["Delivery — dispatch shell", "_shell.delivery.index.tsx", [MUTATES, /can\(/]],
  ["Delivery — tasks", "_shell.delivery.tasks.tsx", [MUTATES, /can\(/]],
  ["Inventory — receiving", "_shell.inventory.receiving.tsx", [MUTATES]],
  ["Inventory — issues", "_shell.inventory.issues.tsx", [MUTATES]],
];

describe("button-by-button UAT — action family pins", () => {
  const present = new Set(routeFiles());
  for (const [family, file, patterns] of FAMILY_PINS) {
    it(`${family} reaches a real handler`, () => {
      expect(present.has(file), `${file} must exist`).toBe(true);
      const s = read(file);
      for (const pattern of patterns) {
        expect(pattern.test(s), `${file} must match ${pattern}`).toBe(true);
      }
    });
  }
});

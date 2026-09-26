/**
 * Staff-route UX classification scan.
 *
 * Classifies every staff-facing route file under src/routes:
 *   A already premium/shared-composed
 *   B acceptable, needs shared spacing/responsive/state normalisation
 *   C legacy/plain, must be migrated
 *   D intentional specialist surface (board / floor / calendar / matrix)
 *   L layout/tab shell (renders <Outlet />, no page body of its own)
 *
 * Guest, delivery storefront, rider, auth and onboarding routes are public
 * surfaces, not staff application routes, so they are out of scope here.
 *
 * Run: bun scripts/ux-audit.ts [--json]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES = "src/routes";

export type RouteClass = "A" | "B" | "C" | "D" | "L" | "R";

const OUT_OF_SCOPE = [
  /^guest\./,
  /^delivery\.\$/,
  /^rider\./,
  /^auth\./,
  // A hotel's own branded staff sign-in entrance: a public sign-in surface
  // like /auth, not a staff application page.
  /^h\.\$propertySlug/,
  /^onboarding\./,
  /^session-expired/,
  /^unauthorized/,
  /^index\./,
  /^public\./,
  // NEØ public front door and partner portal: customer/business surfaces.
  /^start\./,
  /^partner\./,
  // Canonical identity/context chooser is a public entry surface, not a staff page.
  /^continue\./,
];

/** Specialist workspaces that must stay domain-shaped, not card walls. */
export const SPECIALIST = [
  "kitchen.queue",
  "kitchen.display",
  "bar.queue",
  "pastry.queue",
  "delivery.queue",
  "restaurant.floor",
  "restaurant.sell",
  "bar.sell",
  "pos.",
  "pms.room-rack",
  "room-rack",
  "availability",
  "calendar",
  "rates.matrix",
  "finance.ledger",
  "finance.journals",
];

const SHARED_COMPOSITION = [
  "SummaryStrip",
  "CatalogueWorkspace",
  "InspectorSheet",
  "LaneBoard",
  "RequisitionWorkspace",
  "SectionCard",
  "FactSection",
  "CalendarSurface",
  "ReconciliationPanel",
  "DashboardFrame",
];

const STATE_PRIMITIVES = [
  "QueryState",
  "StateSystem",
  "LoadingState",
  "EmptyState",
  "ErrorState",
  "AccessState",
  "AccessDenied",
  "NotConfigured",
  "AwaitingData",
  "OpsGuard",
  "ModulePlaceholder",
];

export function listRouteFiles(): string[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith(".tsx"))
    .filter((f) => f !== "__root.tsx")
    .filter((f) => !OUT_OF_SCOPE.some((re) => re.test(f)))
    .sort();
}

export function isSpecialist(file: string): boolean {
  return SPECIALIST.some((k) => file.includes(k));
}

/** Delegated page bodies live in components; follow one hop so a thin route
 *  that renders a premium workspace is not mis-read as legacy. */
function delegatedSources(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/from "(@\/components\/[^"]+)"/g)) {
    const base = (m[1] ?? "").replace("@/", "src/");
    for (const ext of [".tsx", ".ts"]) {
      if (existsSync(base + ext)) out.push(readFileSync(base + ext, "utf8"));
    }
  }
  // A section route may reuse another section's page body wholesale
  // (kitchen stock count is the Stores counting workspace). Follow that hop
  // too, so a deliberate reuse is not mis-read as an unmigrated page.
  for (const m of source.matchAll(/from "\.\/([^"]+)"/g)) {
    const base = join(ROUTES, m[1] ?? "");
    for (const ext of [".tsx", ".ts"]) {
      if (existsSync(base + ext)) out.push(readFileSync(base + ext, "utf8"));
    }
  }
  return out;
}

export function classify(file: string, source: string, extra: string[] = []): RouteClass {
  const all = [source, ...extra].join("\n");
  const has = (list: string[]) => list.some((n) => all.includes(n));
  if (/throw redirect\(/.test(source) || /component: AppShell/.test(source)) return "R";
  if (/<Outlet\s*\/>/.test(source) && !source.includes("PageHeader")) return "L";
  if (isSpecialist(file)) return "D";
  const hasHeader = all.includes("PageHeader") || all.includes("CatalogueWorkspace");
  const hasComposition = has(SHARED_COMPOSITION);
  // A page that never loads asynchronous data has nothing to put a
  // loading / empty / error state around, so it is not held to that rule.
  const loadsData = /useQuery\(|useInfiniteQuery\(|\.isLoading|\.isPending/.test(all);
  const hasState = has(STATE_PRIMITIVES) || !loadsData;
  if (hasHeader && hasComposition && hasState) return "A";
  if (hasHeader || hasComposition) return "B";
  return "C";
}

/** Structural defects that must never be reintroduced. */
export function defects(source: string): string[] {
  const found: string[] = [];
  // A hard pixel width on a control or container cannot survive the collapsed
  // sidebar or a phone. Responsive (`sm:w-[..]`) and `max-w-[..]` caps are fine,
  // and `min-w-[..]` inside a scrolling table region is intentional.
  if (/(?<![a-z-])(?<!:)w-\[\d{3,}px\]/.test(source.replace(/\bmax-w-\[\d+px\]/g, "").replace(/\bmin-w-\[\d+px\]/g, "")))
    found.push("fixed-pixel-width");
  // Raw provider error text rendered into the page instead of a shared state.
  if (/\{\s*\(?[A-Za-z.?]*[eE]rror[^};]{0,60}\.message[^}]{0,30}\}/.test(
    source.replace(/toast\.error\([^;]*\);/g, ""),
  ))
    found.push("raw-error-message");
  return found;
}

export type RouteRow = { file: string; klass: RouteClass; defects: string[] };

export function scan(): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const file of listRouteFiles()) {
    const source = readFileSync(join(ROUTES, file), "utf8");
    rows.push({
      file,
      klass: classify(file, source, delegatedSources(source)),
      defects: defects(source),
    });
  }
  return rows;
}

if (process.argv[1]?.endsWith("ux-audit.ts")) {
  const rows = scan();
  const counts = rows.reduce<Record<string, number>>(
    (acc, r) => ({ ...acc, [r.klass]: (acc[r.klass] ?? 0) + 1 }),
    {},
  );
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ counts, rows }, null, 2));
  } else {
    console.log("total", rows.length, counts);
    for (const r of rows.filter((r) => r.klass === "C" || r.klass === "B" || r.defects.length))
      console.log(r.klass, r.file, r.defects.join(","));
  }
}

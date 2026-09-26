import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useVisibility } from "@/lib/visibility";
import { DASHBOARDS } from "@/lib/dashboards";
import { cardContract, OPERATIONS_PANELS } from "@/lib/data-sources";
import { CARD_STATE_COPY, type CardState } from "@/lib/card-state";

export const Route = createFileRoute("/admin/dashboard-cards")({
  head: () => ({
    meta: [
      { title: "Dashboard Card Contracts — NEØ Administration" },
      {
        name: "description",
        content:
          "Debug console listing every dashboard card, its resolved state precedence and the backend service, tables, filters and capability behind it.",
      },
      { property: "og:title", content: "Dashboard Card Contracts — NEØ Administration" },
      {
        property: "og:description",
        content: "Inspect the authoritative query behind every operations and role dashboard card.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DashboardCardsPage,
});

/** The order `resolveCardState` evaluates its conditions in. */
const PRECEDENCE: { state: CardState; condition: string }[] = [
  { state: "not-implemented", condition: "widget source is `awaiting-module`" },
  { state: "access-denied", condition: "capability missing, or the query returned 42501 / RLS refusal" },
  { state: "query-failed", condition: "any other query error, or a non-finite value" },
  { state: "loading", condition: "fetch in flight or never settled" },
  { state: "not-configured", condition: "prerequisite master data absent (no workspace, no property)" },
  { state: "no-records", condition: "settled query produced null / no row for this scope" },
  { state: "ready", condition: "settled query produced a real figure" },
];

type Row = {
  dashboard: string;
  dashboardKey: string;
  widgetId: string;
  label: string;
  kind: "kpi" | "panel";
  metric: string;
  service: string;
  tables: string;
  filters: string;
  dateRange: string;
  scope: string;
  calculation: string;
  refresh: string;
  drillTo: string;
  capability: string;
  contracted: boolean;
  implemented: boolean;
};

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (const spec of Object.values(DASHBOARDS)) {
    for (const w of spec.widgets) {
      const metric = w.kind === "kpi" ? (w.metric ?? "") : "";
      const contract =
        w.kind === "kpi"
          ? cardContract(w.id, w.metric)
          : OPERATIONS_PANELS.find((p) => p.key === (w.panel ?? w.id));
      rows.push({
        dashboard: spec.name,
        dashboardKey: spec.key,
        widgetId: w.id,
        label: w.title,
        kind: w.kind,
        metric,
        service: contract?.service ?? "—",
        tables: contract?.sourceTables.join(", ") ?? "—",
        filters: contract?.filters ?? "—",
        dateRange: contract?.dateRange ?? "—",
        scope: contract?.scope ?? "—",
        calculation: contract?.calculation ?? "—",
        refresh: contract?.refresh ?? "—",
        drillTo: contract?.drillTo ?? "—",
        capability: contract?.capability ?? "—",
        contracted: Boolean(contract),
        implemented: w.source !== "awaiting-module",
      });
    }
  }
  return rows;
}

function toCsv(rows: Row[]): string {
  const head = [
    "dashboard",
    "widget",
    "card",
    "kind",
    "metric",
    "service",
    "tables",
    "filters",
    "date range",
    "scope",
    "calculation",
    "refresh",
    "drill-down",
    "capability",
    "implemented",
  ];
  const esc = (v: string | boolean) => `"${String(v).replaceAll('"', '""')}"`;
  return [
    head.join(","),
    ...rows.map((r) =>
      [
        r.dashboard,
        r.widgetId,
        r.label,
        r.kind,
        r.metric || "—",
        r.service,
        r.tables,
        r.filters,
        r.dateRange,
        r.scope,
        r.calculation,
        r.refresh,
        r.drillTo,
        r.capability,
        r.implemented,
      ]
        .map(esc)
        .join(","),
    ),
  ].join("\n");
}

function DashboardCardsPage() {
  const visibility = useVisibility();
  const [search, setSearch] = useState("");
  const [gapsOnly, setGapsOnly] = useState(false);

  const mayView = visibility.canAct("administration", "workspace", "edit");
  const rows = useMemo(buildRows, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (gapsOnly && r.contracted && r.implemented) return false;
      if (!q) return true;
      return [r.dashboard, r.label, r.widgetId, r.metric, r.service, r.tables, r.capability]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, gapsOnly]);

  if (!mayView) {
    return (
      <AccessDeniedPanel reason="denied" subject="the dashboard card contract console" />
    );
  }

  const kpis = rows.filter((r) => r.kind === "kpi");
  const uncontracted = kpis.filter((r) => !r.contracted && r.implemented);
  const notImplemented = rows.filter((r) => !r.implemented);

  return (
    <div>
      <PageHeader
        eyebrow="Administration · Diagnostics"
        title="Dashboard card contracts"
        description="Every card rendered by every role dashboard, the state precedence it resolves through, and the authoritative backend query behind it."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              const blob = new Blob([toCsv(rows)], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "neo-dashboard-card-contracts.csv";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download className="size-4" />
            Export CSV
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Dashboards" value={String(Object.keys(DASHBOARDS).length)} />
        <StatCard label="Cards inventoried" value={String(rows.length)} />
        <StatCard label="KPIs without a contract" value={String(uncontracted.length)} />
        <StatCard label="Awaiting module" value={String(notImplemented.length)} />
      </div>

      <SectionCard
        title="State precedence"
        description="resolveCardState evaluates these in order — the first matching condition wins, so a card can never print a zero while loading, denied or failed."
        className="mb-6"
      >
        <ol className="grid gap-2 sm:grid-cols-2">
          {PRECEDENCE.map((p, i) => (
            <li key={p.state} className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <span className="text-xs font-semibold text-muted-foreground">{i + 1}</span>
              <div>
                <Badge variant="outline" className="mb-1 font-mono text-[11px]">
                  {p.state}
                </Badge>
                <p className="text-muted-foreground">{p.condition}</p>
                <p className="text-xs text-muted-foreground/80">
                  Renders: {CARD_STATE_COPY[p.state].label || "the calculated figure"}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard
        title="Card inventory"
        description="Card → dashboard → service → tables → filters → scope → drill-down → capability."
        actions={
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search card, metric, table…"
              className="h-9 w-full sm:w-60"
            />
            <Button
              variant={gapsOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setGapsOnly((v) => !v)}
            >
              Gaps only
            </Button>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Card</TableHead>
                <TableHead>Dashboard</TableHead>
                <TableHead>Metric / panel</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Tables</TableHead>
                <TableHead>Filters</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Drill-down</TableHead>
                <TableHead>Capability</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={`${r.dashboardKey}:${r.widgetId}:${r.label}`}>
                  <TableCell className="whitespace-nowrap font-medium">
                    {r.label}
                    {!r.implemented ? (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        not implemented
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {r.dashboard}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.metric || r.widgetId}</TableCell>
                  <TableCell className="font-mono text-xs">{r.service}</TableCell>
                  <TableCell className="max-w-[220px] text-xs text-muted-foreground">
                    {r.tables}
                  </TableCell>
                  <TableCell className="max-w-[280px] text-xs text-muted-foreground">
                    {r.filters}
                  </TableCell>
                  <TableCell className="text-xs">{r.scope}</TableCell>
                  <TableCell className="font-mono text-xs">{r.drillTo}</TableCell>
                  <TableCell className="font-mono text-xs">{r.capability}</TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    No cards match this filter.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}

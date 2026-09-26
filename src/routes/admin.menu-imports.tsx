import { useMemo, useState } from "react";
import { ErrorState, LoadingState } from "@/components/common/StateSystem";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useMenuImportBatches, ROUTING_SOURCE_LABEL, type MenuImportBatch } from "@/lib/menu-imports";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export const Route = createFileRoute("/admin/menu-imports")({
  head: () => ({
    meta: [
      { title: "Menu Import Inspector — NEØ Administration" },
      {
        name: "description",
        content:
          "Inspect every menu import batch: supersession, preserved historical rows and the station routing source of each imported item, per property.",
      },
      { property: "og:title", content: "Menu Import Inspector — NEØ Administration" },
      {
        property: "og:description",
        content: "Trace menu catalogue provenance batch by batch, including superseded imports and routing summaries.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MenuImportsPage,
});

function fmtDate(value: string): string {
  return new Date(value).toLocaleString();
}

function SummaryPills({ summary, labels }: { summary: Record<string, number>; labels?: Record<string, string> }) {
  const entries = Object.entries(summary ?? {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([key, count]) => (
        <Badge key={key} variant="outline" className="text-[11px] font-normal">
          {labels?.[key] ?? key} · {count}
        </Badge>
      ))}
    </div>
  );
}

function BatchRow({ batch }: { batch: MenuImportBatch }) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="font-medium">{batch.file_name ?? "Unnamed file"}</span>
        <span className="block font-mono text-[11px] text-muted-foreground">{batch.batch_id.slice(0, 8)}</span>
        <span className="block text-xs text-muted-foreground">{fmtDate(batch.created_at)}</span>
        {batch.created_by_name ? (
          <span className="block text-xs text-muted-foreground">by {batch.created_by_name}</span>
        ) : null}
      </TableCell>
      <TableCell className="align-top">
        <span className="text-sm">{batch.branch_name ?? "Unassigned"}</span>
        <span className="block text-xs text-muted-foreground">{batch.menu_name ?? "No menu"}</span>
      </TableCell>
      <TableCell className="align-top">
        <Badge variant={batch.status === "committed" ? "default" : "secondary"}>{batch.status}</Badge>
        {batch.superseded ? (
          <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">
            Superseded{batch.superseded_by ? ` by ${batch.superseded_by.slice(0, 8)}` : ""}
          </span>
        ) : (
          <span className="mt-1 block text-xs text-muted-foreground">Current</span>
        )}
        {batch.supersedes ? (
          <span className="block text-xs text-muted-foreground">Replaced {batch.supersedes.slice(0, 8)}</span>
        ) : null}
      </TableCell>
      <TableCell className="align-top text-sm">
        <div>{batch.live_rows} live</div>
        <div className="text-xs text-muted-foreground">{batch.historical_rows} preserved history</div>
        <div className="text-xs text-muted-foreground">
          {batch.published_rows} published · {batch.draft_rows} draft
        </div>
      </TableCell>
      <TableCell className="align-top text-sm">
        <div>{batch.total_rows ?? batch.item_rows} rows in file</div>
        <div className="text-xs text-muted-foreground">
          {batch.imported_rows ?? 0} imported · {batch.rejected_rows ?? 0} rejected · {batch.duplicate_rows ?? 0}{" "}
          duplicate
        </div>
      </TableCell>
      <TableCell className="align-top">
        <SummaryPills summary={batch.station_summary} />
        {batch.unrouted_rows > 0 ? (
          <span className="mt-1 block text-xs text-destructive">{batch.unrouted_rows} unrouted</span>
        ) : null}
      </TableCell>
      <TableCell className="align-top">
        <SummaryPills summary={batch.source_summary} labels={ROUTING_SOURCE_LABEL} />
      </TableCell>
    </TableRow>
  );
}

function MenuImportsPage() {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const batches = useMenuImportBatches();
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const all = batches.data ?? [];
    if (!term) return all;
    return all.filter(
      (b) =>
        (b.file_name ?? "").toLowerCase().includes(term) ||
        b.batch_id.toLowerCase().includes(term) ||
        (b.branch_name ?? "").toLowerCase().includes(term) ||
        (b.menu_name ?? "").toLowerCase().includes(term),
    );
  }, [batches.data, search]);

  if (!can("pos", "menu", "view")) {
    return <AccessDeniedPanel subject="the menu import inspector" detail="Requires the pos.menu.view capability." />;
  }

  const live = rows.reduce((sum, b) => sum + b.live_rows, 0);
  const history = rows.reduce((sum, b) => sum + b.historical_rows, 0);
  const unrouted = rows.reduce((sum, b) => sum + b.unrouted_rows, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Menu Import Inspector"
        description={`Every menu import batch for ${branchId ? "the selected property" : "all properties"}, with supersession, preserved history and the routing source of each imported item.`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Batches" value={String(rows.length)} />
        <StatCard label="Live items" value={String(live)} />
        <StatCard label="Preserved history" value={String(history)} />
        <StatCard label="Unrouted items" value={String(unrouted)} />
      </div>

      <SectionCard title="Import batches" description="Newest first. Superseded batches keep their historical rows.">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search file, batch id, property or menu"
          className="mb-4 max-w-md"
          aria-label="Search import batches"
        />
        {batches.isLoading ? (
          <div className="space-y-2">
            <LoadingState variant="rows" rows={3} />
            <LoadingState variant="rows" rows={3} />
            <LoadingState variant="rows" rows={3} />
          </div>
        ) : batches.error ? (
          <ErrorState error={batches.error} inline />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No menu import batches recorded for this scope.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>Property / menu</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Catalogue rows</TableHead>
                  <TableHead>File outcome</TableHead>
                  <TableHead>Stations</TableHead>
                  <TableHead>Routing source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <BatchRow key={b.batch_id} batch={b} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

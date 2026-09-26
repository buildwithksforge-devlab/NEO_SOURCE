/**
 * Live stock — every store in the selected property, side by side.
 *
 * Each figure is the store's current balance. "Recalculate from the ledger"
 * rebuilds those balances from every recorded movement — goods received,
 * issues, sales consumption, transfers, waste and reversals — and reports what
 * it corrected. Lines with no recorded movements are reported, never zeroed.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Boxes, PackageX, RefreshCw, Search, Warehouse } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { OpsGuard } from "@/components/operations/OpsShared";
import { QueryState } from "@/components/common/StateSystem";
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
import { formatQuantity, titleCase } from "@/lib/inventory";
import {
  useLiveStockBoard,
  useRecalculateStockLevels,
  type LiveStockStore,
} from "@/lib/inventory-data";

export const Route = createFileRoute("/_shell/inventory/live")({
  head: () => ({
    meta: [
      { title: "Live Stock — NEØ" },
      {
        name: "description",
        content:
          "Every store's current stock level for the selected property, recalculated on demand from the movement ledger.",
      },
      { property: "og:title", content: "Live Stock — NEØ" },
      {
        property: "og:description",
        content: "Current stock level per store, rebuilt from receipts, issues, sales and returns.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/inventory/live">
      <LiveStockPage />
    </OpsGuard>
  ),
});

function money(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function when(value: string | null | undefined): string {
  if (!value) return "No movement recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No movement recorded" : date.toLocaleString();
}

function LiveStockPage() {
  const board = useLiveStockBoard();
  const recalculate = useRecalculateStockLevels();
  const [search, setSearch] = useState("");

  const stores = (board.data?.stores ?? []) as LiveStockStore[];
  const totals = board.data?.totals ?? {
    lines: 0,
    value: 0,
    below_minimum: 0,
    below_reorder: 0,
    out_of_stock: 0,
  };
  const refused = board.data?.ok === false;

  const term = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!term) return stores;
    return stores
      .map((store) => ({
        ...store,
        items: store.items.filter(
          (i) =>
            i.name.toLowerCase().includes(term) || String(i.sku ?? "").toLowerCase().includes(term),
        ),
      }))
      .filter((store) => store.items.length > 0 || store.location_name.toLowerCase().includes(term));
  }, [stores, term]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live Stock"
        description="What each store in this property is holding right now, and how to rebuild those balances from the movement ledger."
        actions={
          <Button
            onClick={() => recalculate.mutate()}
            disabled={recalculate.isPending || board.isLoading}
          >
            <RefreshCw className={recalculate.isPending ? "size-4 animate-spin" : "size-4"} />
            {recalculate.isPending ? "Recalculating…" : "Recalculate from the ledger"}
          </Button>
        }
        meta={board.data?.generated_at ? `Read ${when(board.data.generated_at)}` : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Stores reporting" value={String(stores.length)} icon={Warehouse} lead />
        <StatCard label="Item lines held" value={String(totals.lines)} icon={Boxes} />
        <StatCard
          label="Below minimum"
          value={String(totals.below_minimum)}
          icon={AlertTriangle}
          tone={totals.below_minimum > 0 ? "warning" : "default"}
        />
        <StatCard
          label="To reorder"
          value={String(totals.below_reorder)}
          icon={AlertTriangle}
          tone={totals.below_reorder > 0 ? "warning" : "default"}
          hint="At or below the reorder point"
        />
        <StatCard
          label="Out of stock"
          value={String(totals.out_of_stock)}
          icon={PackageX}
          tone={totals.out_of_stock > 0 ? "destructive" : "default"}
          hint={`Stock value on hand ${money(Number(totals.value ?? 0))}`}
        />
      </div>

      <SectionCard
        title="Search"
        description="Filter every store at once by item name or code."
        icon={Search}
      >
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search all stores by item name or code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search stock across stores"
          />
        </div>
      </SectionCard>

      <QueryState
        isLoading={board.isLoading}
        error={board.error}
        isEmpty={!board.isLoading && !refused && visible.length === 0}
        empty={
          term
            ? "Nothing in these stores matches that search."
            : "No store is holding recorded stock for this property yet."
        }
      >
        {refused ? (
          <SectionCard title="Not available" description="This property's stock cannot be read with your current access.">
            <p className="text-sm text-muted-foreground">
              {board.data?.reason === "not_permitted"
                ? "You do not have access to this property's stores."
                : "Select a property to see its stores."}
            </p>
          </SectionCard>
        ) : (
          <div className="space-y-6">
            {visible.map((store) => (
              <SectionCard
                key={store.location_id}
                title={store.location_name}
                description={`${store.location_type ? titleCase(store.location_type) : "Store"} · last movement ${when(store.last_movement_at)}`}
                icon={Warehouse}
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone="default">{store.lines} lines</StatusPill>
                    {store.below_minimum > 0 ? (
                      <StatusPill tone="warning">{store.below_minimum} below minimum</StatusPill>
                    ) : null}
                    {store.below_reorder > 0 ? (
                      <StatusPill tone="warning">{store.below_reorder} to reorder</StatusPill>
                    ) : null}
                    {store.out_of_stock > 0 ? (
                      <StatusPill tone="destructive">{store.out_of_stock} out of stock</StatusPill>
                    ) : null}
                    <StatusPill tone="info">Value {money(Number(store.value ?? 0))}</StatusPill>
                  </div>
                }
              >
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead className="text-right">On hand</TableHead>
                        <TableHead className="text-right">Minimum</TableHead>
                        <TableHead className="text-right">Reorder at</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                        <TableHead>Last movement</TableHead>
                        <TableHead>State</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {store.items.map((item) => {
                        const out = Number(item.on_hand) <= 0;
                        const low =
                          !out && Number(item.minimum_stock) > 0 && Number(item.on_hand) <= Number(item.minimum_stock);
                        const reorder =
                          !out && Number(item.reorder_point) > 0 && Number(item.on_hand) <= Number(item.reorder_point);
                        return (
                          <TableRow key={`${store.location_id}-${item.stock_item_id}`}>
                            <TableCell className="font-medium">{item.name}</TableCell>
                            <TableCell className="text-muted-foreground">{item.sku ?? "—"}</TableCell>
                            <TableCell className="text-right">
                              {formatQuantity(item.on_hand, item.unit ?? "")}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {Number(item.minimum_stock) > 0 ? formatQuantity(item.minimum_stock, item.unit ?? "") : "—"}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {Number(item.reorder_point) > 0
                                ? formatQuantity(item.reorder_point, item.unit ?? "")
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right">{money(Number(item.value ?? 0))}</TableCell>
                            <TableCell className="text-muted-foreground">{when(item.last_movement_at)}</TableCell>
                            <TableCell>
                              {out ? (
                                <StatusPill tone="destructive">Out of stock</StatusPill>
                              ) : low ? (
                                <StatusPill tone="warning">Below minimum</StatusPill>
                              ) : reorder ? (
                                <StatusPill tone="warning">Reorder now</StatusPill>
                              ) : (
                                <StatusPill tone="success">Healthy</StatusPill>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableScroll>
              </SectionCard>
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );
}

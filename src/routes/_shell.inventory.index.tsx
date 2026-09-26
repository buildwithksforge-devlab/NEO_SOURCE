import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { AlertTriangle, Boxes, PackagePlus, PackageX, Timer, Warehouse } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { ReceiveStockDialog } from "@/components/inventory/ReceiveStockDialog";
import { QueryState } from "@/components/pms/PmsShared";

import { useTenant } from "@/lib/tenant";
import { useWriteBranchId } from "@/lib/branch-filter";
import {
  daysUntil,
  formatMoney,
  formatQuantity,
  healthLabel,
  healthTone,
  num,
  stockHealth,
  titleCase,
  type Row,
} from "@/lib/inventory";
import {
  reorderQuantityFor,
  useExpiringBatches,
  useInventoryMetrics,
  useRaiseReorderRequest,
  useReorderSuggestions,
  useReplenishmentRecommendations,
  useStockItems,
  useStockMovements,
} from "@/lib/inventory-data";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/inventory/")({
  head: () => ({
    meta: [
      { title: "Inventory & Stores — NEØ" },
      {
        name: "description",
        content:
          "Live stock levels, valuation, expiry alerts and recipe-driven consumption across every store.",
      },
      { property: "og:title", content: "Inventory & Stores — NEØ" },
      {
        property: "og:description",
        content:
          "Live stock levels, valuation, expiry alerts and recipe-driven consumption across every store.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function onHandOf(item: Row): number {
  const levels = (item["stock_levels"] ?? []) as Row[];
  return levels.reduce((total, level) => total + num(level["quantity_on_hand"]), 0);
}

function Page() {
  const { tenant } = useTenant();
  const { can } = useAuth();
  const symbol = tenant.regional.currencySymbol;
  const metrics = useInventoryMetrics();
  const items = useStockItems();
  const reorder = useReorderSuggestions();
  const recommendations = useReplenishmentRecommendations();
  const batches = useExpiringBatches();
  const movements = useStockMovements(20);
  const raiseRequest = useRaiseReorderRequest();
  // A purchase request belongs to exactly one property, so the action is only
  // offered once a property is resolved (selected, or the user's home property).
  const writeBranchId = useWriteBranchId();
  const mayRequest = can("procurement", "requests", "create") && Boolean(writeBranchId);
  // Stock-item authority is `stores.items.*` only; supplier administration is
  // not an alternative route into editing the catalogue.
  const mayEditItems = can("stores", "items", "edit");


  const m = metrics.data ?? {};
  const itemRows = (items.data ?? []) as Row[];
  const reorderRows = (reorder.data ?? []) as Row[];
  const batchRows = (batches.data ?? []) as Row[];
  const movementRows = (movements.data ?? []) as Row[];
  const [receiveOpen, setReceiveOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supply Chain"
        title="Inventory & Stores"
        description="Every store, item and movement in one ledger — valued at weighted average cost and deducted automatically through recipes when items are sold."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setReceiveOpen(true)}>
              <PackagePlus className="size-4" />
              Receive stock
            </Button>
            <Button variant="outline" asChild>
              <Link to="/inventory/receiving">Receive against PO</Link>
            </Button>
            {mayEditItems ? (
              <Button variant="outline" asChild>
                <Link to="/inventory/items">Stock items</Link>
              </Button>
            ) : null}
          </div>
        }
      />

      <ReceiveStockDialog open={receiveOpen} onOpenChange={setReceiveOpen} />


      <div className="neo-kpi-grid">
        <StatCard
          lead
          label="Stock value"
          value={formatMoney(m["stock_value"], symbol)}
          hint={`${num(m["item_count"])} active items`}
          icon={Warehouse}
        />
        <StatCard
          label="Below minimum"
          value={String(num(m["low_stock"]))}
          hint={`${num(m["out_of_stock"])} out of stock`}
          icon={AlertTriangle}
          tone="warning"
        />
        <StatCard
          label="Expiring in 7 days"
          value={String(num(m["expiring_soon"]))}
          hint={`${num(m["expired"])} already expired`}
          icon={Timer}
          tone="warning"
        />
        <StatCard
          label="Consumed today"
          value={formatMoney(m["consumption_today"], symbol)}
          hint={`${formatMoney(m["receipts_today"], symbol)} received`}
          icon={Boxes}
        />
      </div>

      <SectionCard
        title="Reorder suggestions"
        description="Items at or below their minimum level, with the quantity needed to return to par."
      >
        <QueryState
          isLoading={reorder.isLoading}
          error={reorder.error}
          isEmpty={reorderRows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No items are below their minimum level.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {reorderRows.map((r) => (
              <li
                key={String(r["id"])}
                className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{String(r["name"])}</p>
                  <p className="text-xs text-muted-foreground">
                    {`On hand ${formatQuantity(r["on_hand"], r["base_unit"])} · minimum ${formatQuantity(r["min_level"], r["base_unit"])}`}
                    {r["supplier_name"] ? ` · ${String(r["supplier_name"])}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone="warning">
                    Order {formatQuantity(reorderQuantityFor(r), r["base_unit"])}
                  </StatusPill>
                  {mayRequest ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={raiseRequest.isPending}
                      onClick={() =>
                        raiseRequest.mutate({ item: r, quantity: reorderQuantityFor(r) })
                      }
                    >
                      Raise purchase request
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Replenishment recommendations"
        description="Raised automatically when a sale consumed an item below its threshold. These are recommendations for procurement only — no order is created, approved or placed here."
      >
        <QueryState
          isLoading={recommendations.isLoading}
          error={recommendations.error}
          isEmpty={(recommendations.data ?? []).length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No open replenishment recommendations. Consumption has stayed above every configured threshold.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {(recommendations.data ?? []).map((rec) => {
              const item = (rec["stock_items"] as Row | null) ?? null;
              return (
                <li key={String(rec["id"])} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{String(item?.["name"] ?? "Stock item")}</p>
                    <p className="text-xs text-muted-foreground">
                      {`${formatQuantity(Number(rec["on_hand"] ?? 0), item?.["base_unit"])} on hand · threshold ${formatQuantity(Number(rec["threshold"] ?? 0), item?.["base_unit"])} · recommend ${formatQuantity(Number(rec["recommended_quantity"] ?? 0), item?.["base_unit"])}`}
                    </p>
                  </div>
                  <StatusPill tone="warning">Recommended</StatusPill>
                </li>
              );
            })}
          </ul>
        </QueryState>
      </SectionCard>


      <SectionCard
        title="Stock items"
        description="Live balances across all stores, valued at weighted average cost."
      >
        <QueryState
          isLoading={items.isLoading}
          error={items.error}
          isEmpty={itemRows.length === 0}
          empty={
            <div className="py-6 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">No stock items yet</p>
              <p>
                Create your stores, categories and items to start tracking movement and consumption.
              </p>
            </div>
          }
        >
          <ul className="divide-y divide-border">
            {itemRows.map((item) => {
              const onHand = onHandOf(item);
              const health = stockHealth(
                onHand,
                num(item["min_level"]),
                item["max_level"] as number | null,
              );
              const category = (item["stock_categories"] as Row | null)?.["name"];
              return (
                <li
                  key={String(item["id"])}
                  className="flex items-start justify-between gap-3 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{String(item["name"])}</p>
                    <p className="text-xs text-muted-foreground">
                      {`${category ? `${String(category)} · ` : ""}${formatQuantity(onHand, item["base_unit"])} on hand · avg cost ${formatMoney(item["average_cost"], symbol)}`}
                    </p>
                  </div>
                  <StatusPill tone={healthTone(health)}>{healthLabel(health)}</StatusPill>
                </li>
              );
            })}
          </ul>
        </QueryState>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Expiry watch" description="Open batches closest to their expiry date.">
          <QueryState
            isLoading={batches.isLoading}
            error={batches.error}
            isEmpty={batchRows.length === 0}
            empty={
              <p className="py-6 text-sm text-muted-foreground">No batch-tracked stock on hand.</p>
            }
          >
            <ul className="divide-y divide-border">
              {batchRows.map((b) => {
                const days = daysUntil(b["expiry_date"]);
                return (
                  <li
                    key={String(b["id"])}
                    className="flex items-start justify-between gap-3 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {String((b["stock_items"] as Row | null)?.["name"] ?? "Item")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {`${b["batch_number"] ? `Batch ${String(b["batch_number"])} · ` : ""}${formatQuantity(b["quantity"], (b["stock_items"] as Row | null)?.["base_unit"])} · ${String((b["stock_locations"] as Row | null)?.["name"] ?? "Store")}`}
                      </p>
                    </div>
                    <StatusPill
                      tone={
                        days !== null && days < 0
                          ? "destructive"
                          : days !== null && days <= 7
                            ? "warning"
                            : "default"
                      }
                    >
                      {days === null
                        ? "No expiry"
                        : days < 0
                          ? `Expired ${Math.abs(days)}d ago`
                          : `${days}d left`}
                    </StatusPill>
                  </li>
                );
              })}
            </ul>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Recent movements"
          description="Receipts, issues, transfers, consumption and corrections."
        >
          <QueryState
            isLoading={movements.isLoading}
            error={movements.error}
            isEmpty={movementRows.length === 0}
            empty={<p className="py-6 text-sm text-muted-foreground">No stock has moved yet.</p>}
          >
            <ul className="divide-y divide-border">
              {movementRows.map((mv) => (
                <li
                  key={String(mv["id"])}
                  className="flex items-start justify-between gap-3 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium">
                      {String((mv["stock_items"] as Row | null)?.["name"] ?? "Item")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {`${titleCase(String(mv["movement_type"] ?? ""))} · ${formatQuantity(mv["quantity"], mv["unit"])}`}
                      {mv["reason"] ? ` · ${String(mv["reason"])}` : ""}
                      {mv["source_requisition"]
                        ? ` · ${String((mv["source_requisition"] as Row)["request_number"] ?? "Requisition")} · ${String(((mv["source_requisition"] as Row)["departments"] as Row | null)?.["name"] ?? "Department not recorded")}`
                        : ""}
                    </p>
                  </div>
                  <StatusPill tone={num(mv["quantity"]) < 0 ? "destructive" : "success"}>
                    {formatMoney(Math.abs(num(mv["value"])), symbol)}
                  </StatusPill>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>
      </div>

      <SectionCard
        title="Losses & variance"
        description="Adjustments, damage, expiry and stock-take differences over the last 30 days."
      >
        <div className="flex items-center gap-3 text-sm">
          <PackageX className="size-4 text-muted-foreground" />
          <span className="text-2xl font-semibold">{formatMoney(m["variance_30d"], symbol)}</span>
          <span className="text-muted-foreground">total variance value posted to the ledger</span>
        </div>
      </SectionCard>
    </div>
  );
}

// Every Supply Chain screen writes to stock, money or supplier records, so the
// page itself asks for the capability its route declares — never the shell.
function GuardedPage() {
  return (
    <OpsGuard path="/inventory">
      <Page />
    </OpsGuard>
  );
}

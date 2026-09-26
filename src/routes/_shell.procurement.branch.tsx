/**
 * Branch procurement dashboard.
 *
 * Everything a buyer needs for the property they are standing in: stock below
 * that property's own reorder point, purchase requests raised there, orders
 * approved and awaiting delivery, and receipts posted. All reads follow the
 * active property selection, so one branch never sees another branch's stock.
 */
import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Boxes, ClipboardList, PackageCheck, ShoppingCart, Truck } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { OpsGuard } from "@/components/operations/OpsShared";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBranchScope } from "@/lib/branches";
import { useTenant } from "@/lib/tenant";
import { formatMoney, formatQuantity, num, type Row } from "@/lib/inventory";
import { usePurchaseRequests, useWeeklyStockReport } from "@/lib/inventory-data";
import { usePurchaseOrderBoard } from "@/lib/procurement-orders";

export const Route = createFileRoute("/_shell/procurement/branch")({
  head: () => ({
    meta: [
      { title: "Branch procurement — NEØ" },
      {
        name: "description",
        content:
          "Stock below reorder point, purchase requests, approved orders and receipts for the property you are working in.",
      },
      { property: "og:title", content: "Branch procurement — NEØ" },
      {
        property: "og:description",
        content: "One property's own stock, reorder alerts, requests, orders and receipts in a single view.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/procurement">
      <BranchProcurementPage />
    </OpsGuard>
  ),
});

function BranchProcurementPage() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { activeBranch } = useBranchScope();

  const report = useWeeklyStockReport();
  const requests = usePurchaseRequests();
  const board = usePurchaseOrderBoard();

  const rows = (report.data ?? []) as Row[];
  const alerts = useMemo(() => rows.filter((r) => r["below_reorder"] === true), [rows]);

  const pendingRequests = useMemo(
    () =>
      ((requests.data ?? []) as Row[]).filter((r) =>
        ["draft", "submitted", "pending", "pending_approval", "approved"].includes(String(r["status"] ?? "")),
      ),
    [requests.data],
  );

  const orders = board.data ?? [];
  const awaiting = orders.filter((o) => o.stage === "open" || o.stage === "partly_received");
  const overdue = awaiting.filter((o) => o.overdue);
  const receiptsPosted = orders.reduce((s, o) => s + o.receipts.length, 0);
  const committed = awaiting.reduce((s, o) => s + o.total, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Boxes}
        eyebrow="Procurement"
        title={activeBranch ? `${activeBranch.name} procurement` : "Branch procurement"}
        description={
          activeBranch
            ? "Only this property's stock, reorder points, requests and orders."
            : "Choose a property in the header to see a single branch's own stock and orders."
        }
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/procurement/requests">Requests</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/procurement/supplier-portal">Supplier portal</Link>
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Items below reorder point"
          value={String(alerts.length)}
          icon={AlertTriangle}
          tone={alerts.length > 0 ? "warning" : "default"}
          lead
        />
        <StatCard label="Requests in flight" value={String(pendingRequests.length)} icon={ClipboardList} />
        <StatCard
          label="Orders awaiting delivery"
          value={String(awaiting.length)}
          {...(overdue.length > 0 ? { hint: `${overdue.length} past the promised date` } : {})}
          icon={Truck}
        />
        <StatCard label="Committed with suppliers" value={formatMoney(committed, symbol)} icon={ShoppingCart} />
      </div>

      <SectionCard title="Below reorder point" description="This property's own reorder rules, measured against its own balance.">
        <QueryState
          query={report}
          isLoading={report.isLoading}
          error={report.error}
          isEmpty={alerts.length === 0}
          empty="Nothing is below its reorder point in this property."
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Group / category</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Reorder point</TableHead>
                  <TableHead className="text-right">Par</TableHead>
                  <TableHead className="text-right">Already requested</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.slice(0, 100).map((r) => (
                  <TableRow key={`${String(r["item_id"])}-${String(r["branch_id"] ?? "org")}`}>
                    <TableCell className="font-medium">{String(r["item_name"] ?? "Unnamed")}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {String(r["group_name"] ?? "No item group")} · {String(r["category_name"] ?? "Not categorised")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQuantity(num(r["on_hand"]))} {String(r["base_unit"] ?? "")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r["reorder_point"] === null || r["reorder_point"] === undefined ? "—" : formatQuantity(num(r["reorder_point"]))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r["par_level"] === null || r["par_level"] === undefined ? "—" : formatQuantity(num(r["par_level"]))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(r["pending_request_quantity"]) > 0 ? formatQuantity(num(r["pending_request_quantity"])) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Orders awaiting delivery"
        description="Approved orders this property is still waiting on."
        actions={
          <StatusPill tone={receiptsPosted > 0 ? "success" : "default"}>
            <PackageCheck className="mr-1 h-3 w-3" /> {receiptsPosted} receipts posted
          </StatusPill>
        }
      >
        <QueryState
          query={board}
          isLoading={board.isLoading}
          error={board.error}
          isEmpty={awaiting.length === 0}
          empty="No approved orders are outstanding in this property."
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Still owed</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {awaiting.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">{o.number}</TableCell>
                    <TableCell>{o.supplier}</TableCell>
                    <TableCell className={o.overdue ? "text-destructive" : undefined}>
                      {o.expected ? new Date(o.expected).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(o.outstanding)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(o.total, symbol)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { ClipboardList, PackageCheck, ShoppingCart, Truck } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/pms/PmsShared";
import { ReconciliationPanel } from "@/components/common/ReconciliationPanel";
import { useProcurementReconciliation } from "@/lib/ops-reconciliation";
import { Button } from "@/components/ui/button";
import { useTenant } from "@/lib/tenant";
import { formatMoney, num, statusTone, titleCase, type Row } from "@/lib/inventory";
import {
  useGoodsReceipts,
  useInventoryMetrics,
  usePostReceipt,
  usePurchaseOrders,
  usePurchaseRequests,
  useSuppliers,
} from "@/lib/inventory-data";

export const Route = createFileRoute("/_shell/procurement/")({
  head: () => ({
    meta: [
      { title: "Procurement — NEØ" },
      {
        name: "description",
        content:
          "Suppliers, purchase requests, orders and goods received notes that post straight into stock.",
      },
      { property: "og:title", content: "Procurement — NEØ" },
      {
        property: "og:description",
        content:
          "Suppliers, purchase requests, orders and goods received notes that post straight into stock.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const metrics = useInventoryMetrics();
  const suppliers = useSuppliers();
  const requests = usePurchaseRequests();
  const orders = usePurchaseOrders();
  const receipts = useGoodsReceipts();
  const postReceipt = usePostReceipt();
  const procurementHealth = useProcurementReconciliation();

  const m = metrics.data ?? {};
  const supplierRows = (suppliers.data ?? []) as Row[];
  const requestRows = (requests.data ?? []) as Row[];
  const orderRows = (orders.data ?? []) as Row[];
  const receiptRows = (receipts.data ?? []) as Row[];
  const approvedOrders = orderRows.filter((o) =>
    ["approved", "sent", "partially-received", "partially_received"].includes(
      String(o["status"] ?? ""),
    ),
  );
  const pendingReceipts = receiptRows.filter((g) => String(g["status"] ?? "") !== "posted");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supply Chain"
        title="Procurement"
        description="Requisitions, supplier quotes, purchase orders and receiving — every posted delivery updates stock levels and costs automatically."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/procurement/requests">Purchase requests</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/procurement/orders">Purchase orders</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/inventory/receiving">Receive a delivery</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/inventory/levels">Stock levels</Link>
            </Button>
          </div>
        }
      />

      <div className="neo-kpi-grid">
        <StatCard
          lead
          label="Open requests"
          value={String(num(m["open_requests"]))}
          hint={`${num(m["pending_approvals"])} awaiting approval`}
          icon={ClipboardList}
          tone="warning"
        />
        <StatCard
          label="Approved purchase orders"
          value={String(approvedOrders.length)}
          hint="Issued to suppliers, awaiting delivery"
          icon={ShoppingCart}
        />
        <StatCard
          label="Deliveries not yet in stock"
          value={String(pendingReceipts.length)}
          hint="Goods received notes still to post"
          icon={Truck}
          tone={pendingReceipts.length > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Received today"
          value={formatMoney(m["receipts_today"], symbol)}
          hint="Value posted into stores"
          icon={PackageCheck}
          tone="success"
        />
      </div>

      <SectionCard
        title="Purchase requests"
        description="Departmental requisitions moving through approval."
      >
        <QueryState
          isLoading={requests.isLoading}
          error={requests.error}
          isEmpty={requestRows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No purchase requests have been raised yet.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {requestRows.map((r) => (
              <li
                key={String(r["id"])}
                className="flex items-start justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {String(r["request_number"] ?? r["title"] ?? "Request")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {`${(r["departments"] as Row | null)?.["name"] ?? "Department"} · ${titleCase(String(r["priority"] ?? "normal"))} · est. ${formatMoney(r["estimated_total"], symbol)}`}
                  </p>
                </div>
                <StatusPill tone={statusTone(String(r["status"] ?? ""))}>
                  {titleCase(String(r["status"] ?? "draft"))}
                </StatusPill>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Purchase orders"
        description="Orders issued to suppliers and their receiving progress."
      >
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={orderRows.length === 0}
          empty={<p className="py-6 text-sm text-muted-foreground">No purchase orders yet.</p>}
        >
          <ul className="divide-y divide-border">
            {orderRows.map((o) => (
              <li
                key={String(o["id"])}
                className="flex items-start justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <Link
                    to="/lpos/$id"
                    params={{ id: String(o["id"]) }}
                    className="font-medium hover:underline"
                  >
                    {String(o["order_number"] ?? "Purchase order")}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {`${(o["suppliers"] as Row | null)?.["name"] ?? "Supplier"} · ${formatMoney(o["total_amount"], symbol)}`}
                    {o["expected_date"] ? ` · expected ${String(o["expected_date"])}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={statusTone(String(o["status"] ?? ""))}>
                    {titleCase(String(o["status"] ?? "draft"))}
                  </StatusPill>
                  <Link
                    to="/lpos/$id"
                    params={{ id: String(o["id"]) }}
                    className="text-xs text-primary hover:underline"
                  >
                    Document trail
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Goods received notes"
        description="Post a delivery to move it into the receiving store at the delivered cost."
      >
        <QueryState
          isLoading={receipts.isLoading}
          error={receipts.error}
          isEmpty={receiptRows.length === 0}
          empty={<p className="py-6 text-sm text-muted-foreground">No deliveries recorded yet.</p>}
        >
          <ul className="divide-y divide-border">
            {receiptRows.map((g) => (
              <li
                key={String(g["id"])}
                className="flex items-center justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{String(g["grn_number"] ?? "Delivery")}</p>
                  <p className="text-xs text-muted-foreground">
                    {`${(g["suppliers"] as Row | null)?.["name"] ?? "Supplier"} → ${(g["stock_locations"] as Row | null)?.["name"] ?? "Store"} · ${formatMoney(g["total_value"], symbol)}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={statusTone(String(g["status"] ?? ""))}>
                    {titleCase(String(g["status"] ?? "draft"))}
                  </StatusPill>
                  {String(g["status"]) !== "posted" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={postReceipt.isPending}
                      onClick={() => postReceipt.mutate(String(g["id"]))}
                    >
                      Post to stock
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      <SectionCard title="Suppliers" description="Contacts, terms and delivery performance.">
        <QueryState
          isLoading={suppliers.isLoading}
          error={suppliers.error}
          isEmpty={supplierRows.length === 0}
          empty={<p className="py-6 text-sm text-muted-foreground">No suppliers registered yet.</p>}
        >
          <ul className="divide-y divide-border">
            {supplierRows.map((s) => (
              <li
                key={String(s["id"])}
                className="flex items-start justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{String(s["name"])}</p>
                  <p className="text-xs text-muted-foreground">
                    {`${s["contact_person"] ? `${String(s["contact_person"])} · ` : ""}${s["phone"] ?? s["email"] ?? "No contact"} · ${num(s["credit_terms_days"])} day terms`}
                  </p>
                </div>
                <StatusPill
                  tone={
                    num(s["late_deliveries"]) > num(s["on_time_deliveries"]) ? "warning" : "success"
                  }
                >
                  {`${num(s["on_time_deliveries"])} on time / ${num(s["late_deliveries"])} late`}
                </StatusPill>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      <ReconciliationPanel
        title="Procurement and stores reconciliation"
        description="Ordered against received against stock on hand, computed in the database within your property scope."
        report={procurementHealth.data}
        isLoading={procurementHealth.isLoading}
        error={procurementHealth.error}
      />
    </div>
  );
}

// Every Supply Chain screen writes to stock, money or supplier records, so the
// page itself asks for the capability its route declares — never the shell.
function GuardedPage() {
  return (
    <OpsGuard path="/procurement">
      <Page />
    </OpsGuard>
  );
}

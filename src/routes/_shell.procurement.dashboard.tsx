/**
 * Procurement dashboard.
 *
 * One read-only board for the buying desk: orders still awaiting delivery,
 * what has actually been received against them, the money still outstanding
 * and the follow-up tasks attached to those orders. Every figure comes from
 * the purchase orders and their receipt lines — nothing is estimated here.
 */
import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList, PackageCheck, ShoppingCart, Wallet } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DeliveryRemindersCard } from "@/components/procurement/DeliveryRemindersCard";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { formatMoney } from "@/lib/events";
import { titleCase } from "@/lib/procurement";
import { usePurchaseOrderBoard, type OrderView } from "@/lib/procurement-orders";
import { str, useProcurementTasks, type ProcRow } from "@/lib/procurement-department";

export const Route = createFileRoute("/_shell/procurement/dashboard")({
  head: () => ({
    meta: [
      { title: "Procurement Dashboard — NEØ" },
      {
        name: "description",
        content:
          "Purchase orders awaiting delivery, quantities received, money still outstanding and the follow-up tasks attached to them.",
      },
      { property: "og:title", content: "Procurement Dashboard — NEØ" },
      {
        property: "og:description",
        content: "Pending orders, received quantities, outstanding value and follow-up work in one board.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="procurement" action="view">
      <ProcurementDashboardPage />
    </OpsGuard>
  ),
});

const OPEN_TASK = ["open", "in-progress", "pending", "blocked"];

function stageTone(stage: OrderView["stage"]): "default" | "info" | "success" | "warning" | "destructive" {
  if (stage === "completed") return "success";
  if (stage === "cancelled") return "destructive";
  if (stage === "partly_received") return "info";
  if (stage === "awaiting_approval") return "warning";
  return "warning";
}

function ProcurementDashboardPage() {
  const { tenant } = useTenant();
  const { can } = useAuth();
  const symbol = tenant.regional.currencySymbol;
  const board = usePurchaseOrderBoard();
  const tasks = useProcurementTasks();

  const orders = board.data ?? [];

  const pending = useMemo(
    () => orders.filter((o) => o.stage === "open" || o.stage === "partly_received"),
    [orders],
  );

  const awaitingApproval = orders.filter((o) => o.stage === "awaiting_approval");
  const overdue = pending.filter((o) => o.overdue);

  /** Value still awaiting delivery, pro-rated on the undelivered share. */
  const outstandingValue = pending.reduce((sum, o) => {
    if (o.ordered <= 0) return sum + o.total;
    return sum + (o.total * o.outstanding) / o.ordered;
  }, 0);

  const receivedUnits = pending.reduce((s, o) => s + o.received, 0);
  const orderedUnits = pending.reduce((s, o) => s + o.ordered, 0);

  const openTasks = useMemo(
    () =>
      ((tasks.data ?? []) as ProcRow[]).filter((t) =>
        OPEN_TASK.includes(str(t["status"], "open").toLowerCase()),
      ),
    [tasks.data],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ShoppingCart}
        eyebrow="Procurement"
        title="Procurement dashboard"
        description="Orders still awaiting delivery, what has been received, what is still owed and the follow-ups attached."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Orders awaiting delivery"
          value={String(pending.length)}
          hint={`${overdue.length} past the expected date`}
          icon={ShoppingCart}
          tone={overdue.length > 0 ? "warning" : "default"}
          lead
        />
        <StatCard
          label="Received against them"
          value={`${receivedUnits} of ${orderedUnits}`}
          hint="Units accepted on inspection"
          icon={PackageCheck}
        />
        <StatCard
          label="Value still outstanding"
          value={formatMoney(symbol, outstandingValue)}
          hint={`${awaitingApproval.length} order(s) awaiting approval`}
          icon={Wallet}
          tone={outstandingValue > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Open follow-ups"
          value={String(openTasks.length)}
          hint={`of ${((tasks.data ?? []) as ProcRow[]).length} procurement tasks`}
          icon={ClipboardList}
          tone={openTasks.length > 0 ? "warning" : "default"}
        />
      </div>

      <SectionCard
        title="Pending orders"
        description="Ordered against received, with the balance still genuinely awaiting delivery."
        icon={ShoppingCart}
      >
        <QueryState
          isLoading={board.isLoading}
          error={board.error}
          isEmpty={pending.length === 0 && awaitingApproval.length === 0}
          empty="No purchase order is awaiting delivery."
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right">Order value</TableHead>
                  <TableHead>Stage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...awaitingApproval, ...pending].map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">
                      <Link to="/procurement/orders" className="hover:underline">
                        {o.number}
                      </Link>
                    </TableCell>
                    <TableCell>{o.supplier}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {o.expected ? (
                        <span className={o.overdue ? "font-medium text-warning" : undefined}>
                          {o.expected}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{o.ordered}</TableCell>
                    <TableCell className="text-right tabular-nums">{o.received}</TableCell>
                    <TableCell className="text-right tabular-nums">{o.outstanding}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(symbol, o.total)}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={stageTone(o.stage)}>
                        {titleCase(o.stage.replace(/_/g, " "))}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Follow-up tasks"
        description="Delivery follow-ups close themselves once an order is fully received."
        icon={ClipboardList}
      >
        <QueryState
          isLoading={tasks.isLoading}
          error={tasks.error}
          isEmpty={openTasks.length === 0}
          empty="No open procurement follow-ups."
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openTasks.map((t) => {
                  const order = (t["purchase_order"] ?? null) as ProcRow | null;
                  return (
                    <TableRow key={str(t["id"])}>
                      <TableCell className="font-medium">
                        <Link to="/procurement/tasks" className="hover:underline">
                          {str(t["title"], "Task")}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {order ? str(order["order_number"], "—") : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {t["due_at"] ? new Date(str(t["due_at"])).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={str(t["status"]) === "in-progress" ? "info" : "warning"}>
                          {titleCase(str(t["status"], "open").replace(/-/g, " "))}
                        </StatusPill>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <DeliveryRemindersCard canSend={can("procurement", "orders", "edit")} />
    </div>
  );
}

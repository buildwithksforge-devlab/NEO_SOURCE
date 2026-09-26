import { AlertTriangle, Clock, Users } from "lucide-react";
import { MoneyValue } from "@/components/common/MoneyValue";
import { StatusPill } from "@/components/common/DataDisplay";
import { TableStatusBadge } from "@/components/pos/PosShared";
import { cn } from "@/lib/utils";

/**
 * Live service state for one table. Everything shown here is derived from the
 * canonical `pos_orders` row for the table — nothing is invented when a table
 * has no open bill.
 */
export type FloorTableState = {
  id: string;
  code: string;
  areaName: string;
  capacity: number;
  status: string;
  /** Present only when the table currently has an open bill. */
  order?: {
    id: string;
    orderNumber: string;
    guestCount: number;
    waiterName: string | null;
    status: string;
    outstanding: number;
    currency: string;
    /** Whole minutes since the bill was opened. */
    elapsedMinutes: number;
    /** True when service has run past the configured attention threshold. */
    needsAttention: boolean;
  };
};

/** Canonical production wording so the floor and the kitchen agree. */
export function productionLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Ordering";
    case "sent":
      return "Sent to kitchen";
    case "preparing":
      return "In production";
    case "ready":
      return "Ready to serve";
    case "served":
      return "Served";
    default:
      return status.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

export function elapsedLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function FloorTableCard({
  table,
  onSelect,
}: {
  table: FloorTableState;
  onSelect: (table: FloorTableState) => void;
}) {
  const order = table.order;
  const attention = Boolean(order?.needsAttention);
  return (
    <button
      type="button"
      onClick={() => onSelect(table)}
      aria-label={
        order
          ? `Table ${table.code}, ${table.areaName}, open bill ${order.orderNumber}, ${productionLabel(order.status)}`
          : `Table ${table.code}, ${table.areaName}, ${table.status}`
      }
      className={cn(
        "flex min-h-32 w-full min-w-0 flex-col items-start gap-2 rounded-xl border p-4 text-left transition-shadow",
        "hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        attention
          ? "border-destructive/50 bg-destructive/5"
          : order
            ? "border-primary/40 bg-primary/5"
            : table.status === "available"
              ? "border-success/40 bg-success/5"
              : "border-border bg-card",
      )}
    >
      <div className="flex w-full min-w-0 items-start justify-between gap-2">
        <span className="truncate text-lg font-semibold">{table.code}</span>
        {attention ? (
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : null}
      </div>
      <span className="w-full truncate text-xs text-muted-foreground">
        {table.areaName} · {table.capacity} seats
      </span>

      <TableStatusBadge status={table.status} />

      {order ? (
        <div className="mt-1 w-full min-w-0 space-y-1.5 border-t border-border/60 pt-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Users className="size-3.5" aria-hidden /> {order.guestCount}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden /> {elapsedLabel(order.elapsedMinutes)}
            </span>
          </div>
          <div className="truncate text-muted-foreground">
            {order.waiterName ?? "Unassigned attendant"}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StatusPill tone={order.status === "ready" ? "success" : "default"}>
              {productionLabel(order.status)}
            </StatusPill>
            {order.outstanding > 0 ? (
              <MoneyValue
                value={order.outstanding}
                currency={order.currency}
                className="font-medium"
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </button>
  );
}

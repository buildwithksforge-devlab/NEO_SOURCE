/**
 * Banquet reconciliation.
 *
 * What each event was billed, set against the money actually recorded against
 * it, split by how it was taken — cash, M-Pesa, card, bank transfer — and what
 * is still outstanding. Nothing here is inferred: every figure comes from the
 * billed lines and the recorded receipts.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Coins, Scale, Wallet } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  Pill,
} from "@/components/events/EventsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EventBillDialog } from "@/components/events/EventBillDialog";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { formatDate, formatMoney, paymentTone, titleCase } from "@/lib/events";
import { useEventPaymentLedger } from "@/lib/events-data";
import type { Row } from "@/lib/events";

export const Route = createFileRoute("/_shell/events/reconciliation")({
  head: () => ({
    meta: [
      { title: "Banquet Reconciliation — NEØ" },
      {
        name: "description",
        content:
          "Billed banquet value against cash, M-Pesa, card and transfer receipts, with the outstanding balance per event.",
      },
      { property: "og:title", content: "Banquet Reconciliation — NEØ" },
      {
        property: "og:description",
        content: "Billed banquet value against money received, by method, with outstanding balances.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="billing">
      <Page />
    </EventsGuard>
  ),
});

type Bucket = {
  bookingId: string;
  reference: string;
  name: string;
  eventDate: unknown;
  billed: number;
  paymentStatus: string;
  byMethod: Record<string, number>;
  received: number;
  refunded: number;
};

function methodLabel(method: unknown) {
  const key = String(method ?? "unrecorded").toLowerCase();
  if (key === "mpesa" || key === "m-pesa") return "M-Pesa";
  return titleCase(key.replace(/-/g, " "));
}

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const ledger = useEventPaymentLedger();
  const [search, setSearch] = useState("");
  const { can } = useAuth();
  const canRecord = can("events", "billing", "create");
  const [billBooking, setBillBooking] = useState<string | null>(null);

  const buckets = useMemo(() => {
    const map = new Map<string, Bucket>();
    for (const row of (ledger.data ?? []) as Row[]) {
      const booking = (row["event_bookings"] ?? {}) as Row;
      const id = String(row["booking_id"] ?? "");
      if (!id) continue;
      let bucket = map.get(id);
      if (!bucket) {
        bucket = {
          bookingId: id,
          reference: String(booking["event_reference"] ?? "—"),
          name: String(booking["event_name"] ?? "—"),
          eventDate: booking["event_date"],
          billed: Number(booking["total_amount"] ?? 0),
          paymentStatus: String(booking["payment_status"] ?? "unpaid"),
          byMethod: {},
          received: 0,
          refunded: 0,
        };
        map.set(id, bucket);
      }
      const amount = Number(row["amount"] ?? 0);
      const isRefund = String(row["entry_type"] ?? "").toLowerCase().includes("refund") || amount < 0;
      const label = methodLabel(row["method"]);
      bucket.byMethod[label] = (bucket.byMethod[label] ?? 0) + amount;
      if (isRefund) bucket.refunded += Math.abs(amount);
      bucket.received += amount;
    }
    const term = search.trim().toLowerCase();
    return [...map.values()]
      .filter((b) => !term || b.reference.toLowerCase().includes(term) || b.name.toLowerCase().includes(term))
      .sort((a, b) => String(b.eventDate ?? "").localeCompare(String(a.eventDate ?? "")));
  }, [ledger.data, search]);

  const methods = useMemo(() => {
    const set = new Set<string>();
    for (const b of buckets) for (const key of Object.keys(b.byMethod)) set.add(key);
    return [...set].sort();
  }, [buckets]);

  const billedTotal = buckets.reduce((s, b) => s + b.billed, 0);
  const receivedTotal = buckets.reduce((s, b) => s + b.received, 0);
  const outstandingTotal = buckets.reduce((s, b) => s + Math.max(b.billed - b.received, 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Scale}
        eyebrow="Events"
        title="Banquet reconciliation"
        description="Billed value against money recorded, split by how it was taken, with the balance still owed."
        actions={
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search event or reference"
            className="w-56"
          />
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Billed" value={formatMoney(symbol, billedTotal)} icon={Coins} />
        <StatCard label="Received" value={formatMoney(symbol, receivedTotal)} icon={Wallet} />
        <StatCard
          label="Outstanding"
          value={formatMoney(symbol, outstandingTotal)}
          icon={Scale}
          tone={outstandingTotal > 0 ? "warning" : "default"}
        />
      </div>

      <SectionCard
        title="By event"
        description="Only events with recorded receipts appear here. A blank column means no money was taken that way."
      >
        <EventsQueryState
          query={ledger}
          isLoading={ledger.isLoading}
          error={ledger.error}
          isEmpty={buckets.length === 0}
          empty={
            <EventsEmpty
              title="No event receipts recorded"
              description="Record a deposit or payment against an event bill and the reconciliation will build itself here."
            />
          }
        >
          <DataTable
            unit="events"
            head={[
              "Event",
              "Date",
              "Billed",
              ...methods,
              "Received",
              "Outstanding",
              "Status",
              ...(canRecord ? ["Money"] : []),
            ]}
          >
            {buckets.map((b) => {
              const outstanding = b.billed - b.received;
              return (
                <tr key={b.bookingId} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-4">
                    <Link
                      to="/events/bookings/$id"
                      params={{ id: b.bookingId }}
                      className="font-medium hover:underline"
                    >
                      {b.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{b.reference}</div>
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatDate(b.eventDate as string)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatMoney(symbol, b.billed)}</td>
                  {methods.map((m) => (
                    <td key={m} className="py-2 pr-4 whitespace-nowrap">
                      {b.byMethod[m] ? formatMoney(symbol, b.byMethod[m] ?? 0) : "—"}
                    </td>
                  ))}
                  <td className="py-2 pr-4 whitespace-nowrap">{formatMoney(symbol, b.received)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {outstanding > 0 ? (
                      <span className="font-medium text-warning">{formatMoney(symbol, outstanding)}</span>
                    ) : outstanding < 0 ? (
                      <span className="font-medium text-warning">
                        {formatMoney(symbol, Math.abs(outstanding))} over
                      </span>
                    ) : (
                      formatMoney(symbol, 0)
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <Pill tone={paymentTone(b.paymentStatus)} value={b.paymentStatus} />
                  </td>
                  {canRecord ? (
                    <td className="py-2 pr-4">
                      <Button size="sm" variant="outline" onClick={() => setBillBooking(b.bookingId)}>
                        Record money
                      </Button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard
        title="Receipts"
        description="Every recorded receipt in date order, exactly as it was taken."
      >
        <EventsQueryState
          query={ledger}
          isLoading={ledger.isLoading}
          error={ledger.error}
          isEmpty={(ledger.data ?? []).length === 0}
          empty={<EventsEmpty title="No receipts yet" description="Recorded event money will be listed here." />}
        >
          <DataTable unit="receipts" head={["Recorded", "Event", "Entry", "Method", "Reference", "Amount"]}>
            {((ledger.data ?? []) as Row[]).map((row) => {
              const booking = (row["event_bookings"] ?? {}) as Row;
              return (
                <tr key={String(row["id"])} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-4 whitespace-nowrap">{formatDate(String(row["recorded_at"] ?? ""))}</td>
                  <td className="py-2 pr-4">
                    <div>{String(booking["event_name"] ?? "—")}</div>
                    <div className="text-xs text-muted-foreground">{String(booking["event_reference"] ?? "")}</div>
                  </td>
                  <td className="py-2 pr-4">{titleCase(String(row["entry_type"] ?? "payment"))}</td>
                  <td className="py-2 pr-4">{methodLabel(row["method"])}</td>
                  <td className="py-2 pr-4">{String(row["reference"] ?? "—")}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatMoney(symbol, Number(row["amount"] ?? 0))}</td>
                </tr>
              );
            })}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <EventBillDialog
        bookingId={billBooking}
        symbol={symbol}
        open={Boolean(billBooking)}
        onOpenChange={(v) => (!v ? setBillBooking(null) : undefined)}
      />
    </div>
  );
}

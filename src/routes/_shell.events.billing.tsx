import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Coins, Receipt, Wallet } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  Pill,
} from "@/components/events/EventsShared";
import { useTenant } from "@/lib/tenant";
import { formatDate, formatMoney, paymentTone } from "@/lib/events";
import { Button } from "@/components/ui/button";
import { EventBillDialog } from "@/components/events/EventBillDialog";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { useEventBilling, useEventInvoices } from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/billing")({
  head: () => ({
    meta: [
      { title: "Event Billing — NEØ" },
      {
        name: "description",
        content:
          "Contracted value, deposits, collections and balances for every event at the selected property.",
      },
      { property: "og:title", content: "Event Billing — NEØ" },
      {
        property: "og:description",
        content: "Contracted value, deposits, collections and balances for every event.",
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

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const workspace = useEventBilling();
  const invoices = useEventInvoices();
  const invoiceByBooking = invoices.data ?? {};
  const [openBill, setOpenBill] = useState<string | null>(null);
  const rows = (workspace.data ?? []).filter((r) => r.status !== "cancelled");

  const contracted = rows.reduce((s, r) => s + Number(r.total_amount ?? 0), 0);
  const collected = rows.reduce((s, r) => s + Number(r.paid_amount ?? 0), 0);
  const depositsDue = rows.reduce(
    (s, r) => s + Math.max(Number(r.deposit_required ?? 0) - Number(r.deposit_paid ?? 0), 0),
    0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Event Billing"
        description="Money shown here comes from the same event records the dashboard and finance handoff read."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Contracted value" value={formatMoney(symbol, contracted)} icon={Receipt} />
        <StatCard label="Collected" value={formatMoney(symbol, collected)} icon={Wallet} />
        <StatCard
          label="Deposits outstanding"
          value={formatMoney(symbol, depositsDue)}
          icon={Coins}
        />
      </div>

      <SectionCard
        title="Event financial position"
        description={`${rows.length} live events for the selected property`}
      >
        <EventsQueryState
          isLoading={workspace.isLoading}
          error={workspace.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="Nothing to bill yet"
              description="Financial position appears as soon as an event is created."
            />
          }
        >
          <DataTable
            head={[
              "Reference",
              "Event",
              "Date",
              "Charges",
              "Contract",
              "Deposit",
              "Paid",
              "Balance",
              "Payment",
              "Bill",
            ]}
          >
            {rows.map((r) => (
              <tr key={r.booking_id}>
                <td className="py-2 pr-4">
                  <Link
                    to="/events/bookings/$id"
                    params={{ id: r.booking_id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {r.event_reference}
                  </Link>
                </td>
                <td className="py-2 pr-4">{r.event_name ?? "—"}</td>
                <td className="py-2 pr-4">{formatDate(r.event_date)}</td>
                <td className="py-2 pr-4">
                  {r.billing_items} · {formatMoney(symbol, r.billing_total)}
                </td>
                <td className="py-2 pr-4">{formatMoney(symbol, r.total_amount)}</td>
                <td className="py-2 pr-4">
                  {formatMoney(symbol, r.deposit_paid)} / {formatMoney(symbol, r.deposit_required)}
                </td>
                <td className="py-2 pr-4">{formatMoney(symbol, r.paid_amount)}</td>
                <td className="py-2 pr-4 font-medium">{formatMoney(symbol, r.balance_due)}</td>
                <td className="py-2 pr-4">
                  <Pill
                    tone={paymentTone(String(r.payment_status ?? "unpaid"))}
                    value={String(r.payment_status ?? "unpaid")}
                  />
                </td>
                <td className="py-2 pr-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setOpenBill(r.booking_id)}>
                      Open bill
                    </Button>
                    {invoiceByBooking[r.booking_id] ? (
                      <DocumentPrintButton
                        type="invoice"
                        id={invoiceByBooking[r.booking_id]!.id}
                        label={`View / Print Invoice${
                          invoiceByBooking[r.booking_id]!.invoice_number
                            ? ` ${invoiceByBooking[r.booking_id]!.invoice_number}`
                            : ""
                        }`}
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <EventBillDialog
        bookingId={openBill}
        symbol={symbol}
        open={openBill !== null}
        onOpenChange={(v) => setOpenBill(v ? openBill : null)}
      />
    </div>
  );
}

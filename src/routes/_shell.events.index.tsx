import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, CheckCircle2, Coins, Sparkles, TrendingUp, Users } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  Pill,
} from "@/components/events/EventsShared";
import { useTenant } from "@/lib/tenant";
import {
  advisoryInsights,
  bookingTone,
  formatDate,
  formatMoney,
  num,
  readinessPercent,
  readinessTone,
  rollupState,
  titleCase,
  type Row,
} from "@/lib/events";
import {
  useBookings,
  useCloseOutEvent,
  useEnquiries,
  useEventBilling,
  useEventChainStatus,
  useEventsMetrics,
  useReadinessBoard,
} from "@/lib/events-data";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_shell/events/")({
  head: () => ({
    meta: [
      { title: "Events Dashboard — NEØ" },
      {
        name: "description",
        content:
          "Live event pipeline, deposits, department readiness and venue utilisation across the property.",
      },
      { property: "og:title", content: "Events Dashboard — NEØ" },
      {
        property: "og:description",
        content: "Live event pipeline, deposits, department readiness and venue utilisation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard>
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const metrics = useEventsMetrics();
  const bookings = useBookings();
  const enquiries = useEnquiries();
  const readiness = useReadinessBoard();
  // The money and handoff picture comes from the same canonical readers the
  // event workspace uses, so this dashboard cannot drift from the records.
  const chain = useEventChainStatus();
  const billing = useEventBilling();
  const closeOut = useCloseOutEvent();

  const m = metrics.data ?? {};
  const bookingRows = (bookings.data ?? []) as Row[];
  const enquiryRows = (enquiries.data ?? []) as Row[];
  const readinessRows = (readiness.data ?? []) as Row[];

  const openChain = (chain.data ?? []).filter(
    (row) => !["cancelled", "closed", "completed"].includes(String(row.status).toLowerCase()),
  );
  const pendingBeos = openChain.filter(
    (row) => String(row.status).toLowerCase() === "confirmed" && row.beo_status !== "published",
  );
  // The date has passed and nobody has said what happened: the event still
  // counts as operationally live until it is closed out.
  const pastOpen = openChain.filter((row) => row.is_past);
  // Still no published order with the date upon us — flagged before the day,
  // not discovered afterwards.
  const overdueBeos = pendingBeos.filter((row) => row.beo_overdue);
  const billingById = new Map((billing.data ?? []).map((row) => [row.booking_id, row]));
  const billedTotal = openChain.reduce(
    (total, row) => total + (billingById.get(row.booking_id)?.billing_total ?? row.billed_amount ?? 0),
    0,
  );
  const paidTotal = openChain.reduce(
    (total, row) => total + (billingById.get(row.booking_id)?.paid_amount ?? row.paid_amount ?? 0),
    0,
  );

  // The headline enquiry figures are read from the very rows the pipeline below
  // lists, so the card and the pipeline can never disagree about the same
  // property. The metrics RPC still supplies bookings, money and readiness.
  const newEnquiries = enquiryRows.filter((e) => String(e["status"]) === "new").length;
  const followupsDue = enquiryRows.filter((e) => {
    const due = e["next_followup_at"];
    if (!due) return false;
    const status = String(e["status"]);
    if (["converted", "lost", "cancelled", "archived"].includes(status)) return false;
    return new Date(String(due)).getTime() < Date.now();
  }).length;

  const conversion =
    num(m["quotations_total"]) > 0
      ? Math.round((num(m["quotations_accepted"]) / num(m["quotations_total"])) * 100)
      : 0;

  const upcoming = bookingRows
    .filter((b) => new Date(String(b["event_date"])) >= new Date(new Date().toDateString()))
    .sort((a, b) => String(a["event_date"]).localeCompare(String(b["event_date"])))
    .slice(0, 8);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Events Dashboard"
        description="Every figure below is read live from your own organisation's event records — nothing is simulated."
      />

      <div className="neo-kpi-grid">
        <StatCard
          lead
          label="New enquiries"
          value={enquiries.isLoading ? "—" : String(newEnquiries)}
          icon={Sparkles}
          hint={`${followupsDue} follow-ups overdue`}
        />
        <StatCard
          label="Confirmed events"
          value={String(num(m["confirmed"]))}
          icon={CheckCircle2}
          hint={`${num(m["provisional"])} provisional`}
        />
        <StatCard
          label="Events in next 30 days"
          value={String(num(m["upcoming_30d"]))}
          icon={CalendarDays}
          hint={`${num(m["events_today"])} today`}
        />
        <StatCard
          label="Guest forecast (30d)"
          value={String(num(m["guest_forecast"]))}
          icon={Users}
          hint="Guaranteed or expected"
        />
        <StatCard
          label="Deposits outstanding"
          value={formatMoney(symbol, m["deposits_due"])}
          icon={Coins}
        />
        <StatCard
          label="Balances outstanding"
          value={formatMoney(symbol, m["outstanding"])}
          icon={Coins}
        />
        <StatCard
          label="Revenue forecast"
          value={formatMoney(symbol, m["revenue_forecast"])}
          icon={TrendingUp}
        />
        <StatCard
          label="Quotation conversion"
          value={`${conversion}%`}
          icon={TrendingUp}
          hint={`${num(m["quotations_pending"])} awaiting client`}
        />
      </div>

      <SectionCard
        title="Money & handoffs"
        description="Open bookings with what has been billed, what has been paid, and whether the banquet order has reached the kitchen and housekeeping."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/finance" className="text-sm text-primary hover:underline">
              Finance
            </Link>
            <span className="text-sm text-muted-foreground">·</span>
            <Link to="/procurement" className="text-sm text-primary hover:underline">
              Procurement
            </Link>
          </div>
        }
      >
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Open bookings" value={String(openChain.length)} icon={CalendarDays} />
          <StatCard
            label="Banquet orders pending"
            value={String(pendingBeos.length)}
            icon={CheckCircle2}
            hint={
              overdueBeos.length > 0
                ? `${overdueBeos.length} overdue — the date is upon us`
                : "Confirmed without a published order"
            }
          />
          <StatCard
            label="Past events still open"
            value={String(pastOpen.length)}
            icon={CalendarDays}
            hint="The date has passed and no outcome has been recorded"
          />
          <StatCard
            label="Billed / paid"
            value={`${formatMoney(symbol, billedTotal)} / ${formatMoney(symbol, paidTotal)}`}
            icon={Coins}
            hint={`${formatMoney(symbol, Math.max(billedTotal - paidTotal, 0))} outstanding`}
          />
        </div>
        <EventsQueryState
          isLoading={chain.isLoading || billing.isLoading}
          error={chain.error ?? billing.error}
          isEmpty={openChain.length === 0}
          empty={
            <EventsEmpty
              title="No open events"
              description="Confirmed and provisional events appear here with their billing and department handoffs."
            />
          }
        >
          <DataTable head={["Reference", "Date", "Banquet order", "Handoffs", "Billed", "Paid", "Balance"]}>
            {openChain.map((row) => {
              const bill = billingById.get(row.booking_id);
              const billed = bill?.billing_total ?? row.billed_amount;
              const paid = bill?.paid_amount ?? row.paid_amount;
              return (
                <tr key={row.booking_id}>
                  <td className="py-2 pr-4">
                    <Link
                      to="/events/bookings/$id"
                      params={{ id: row.booking_id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {row.event_reference}
                    </Link>
                    <div className="text-xs text-muted-foreground">{row.event_name ?? "—"}</div>
                  </td>
                  <td className="py-2 pr-4">{formatDate(row.event_date)}</td>
                  <td className="py-2 pr-4">
                    <Pill
                      tone={row.beo_status === "published" ? "success" : row.beo_id ? "warning" : "destructive"}
                      value={row.beo_status ? titleCase(row.beo_status) : "Not raised"}
                    />
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    {[
                      row.kitchen_handoff ? null : "Kitchen",
                      row.housekeeping_handoff ? null : "Housekeeping",
                      row.front_office_handoff ? null : "Front office",
                    ].filter(Boolean).join(", ") || "All received"}
                  </td>
                  <td className="py-2 pr-4">{formatMoney(symbol, billed)}</td>
                  <td className="py-2 pr-4">{formatMoney(symbol, paid)}</td>
                  <td className="py-2 pr-4">{formatMoney(symbol, Math.max(billed - paid, 0))}</td>
                </tr>
              );
            })}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard
        title="Events waiting to be closed"
        description="The date has passed. Record what happened so handoffs and readiness stop showing as live work. Closing an event never settles money — any balance stays with Finance."
      >
        {pastOpen.length === 0 ? (
          <EventsEmpty
            title="Nothing waiting"
            description="Every event whose date has passed has an outcome recorded."
          />
        ) : (
          <DataTable head={["Reference", "Date", "Banquet order", "Outstanding", "Outcome"]}>
            {pastOpen.map((row) => (
              <tr key={row.booking_id}>
                <td className="py-2 pr-4">
                  <Link
                    to="/events/bookings/$id"
                    params={{ id: row.booking_id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {row.event_reference}
                  </Link>
                  <div className="text-xs text-muted-foreground">{row.event_name ?? "—"}</div>
                </td>
                <td className="py-2 pr-4">
                  {formatDate(row.event_date)}
                  <div className="text-xs text-muted-foreground">
                    {Math.abs(Number(row.days_to_event ?? 0))} day(s) ago
                  </div>
                </td>
                <td className="py-2 pr-4">
                  <Pill
                    tone={row.beo_status === "published" ? "success" : "warning"}
                    value={row.beo_status ? titleCase(row.beo_status) : "Not raised"}
                  />
                </td>
                <td className="py-2 pr-4">{formatMoney(symbol, Math.max(Number(row.outstanding ?? 0), 0))}</td>
                <td className="py-2 pr-4">
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        { outcome: "completed", label: "It took place" },
                        { outcome: "no-show", label: "No-show" },
                        { outcome: "cancelled", label: "Cancelled" },
                      ] as const
                    ).map((option) => (
                      <Button
                        key={option.outcome}
                        size="sm"
                        variant={option.outcome === "completed" ? "default" : "outline"}
                        disabled={closeOut.isPending && closeOut.variables?.bookingId === row.booking_id}
                        onClick={() => {
                          const reason =
                            option.outcome === "completed"
                              ? null
                              : window.prompt(`Why was ${row.event_reference} recorded as ${option.label}?`);
                          if (option.outcome !== "completed" && !reason?.trim()) return;
                          closeOut.mutate({
                            bookingId: row.booking_id,
                            outcome: option.outcome,
                            ...(reason ? { reason } : {}),
                          });
                        }}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </SectionCard>




      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Upcoming events" description="Next confirmed and provisional functions">
          <EventsQueryState
            isLoading={bookings.isLoading}
            error={bookings.error}
            isEmpty={upcoming.length === 0}
            empty={
              <EventsEmpty
                title="No upcoming events"
                description="Confirmed bookings appear here as soon as an enquiry is converted and confirmed."
              />
            }
          >
            <DataTable head={["Reference", "Event", "Date", "Venue", "Guests", "Status"]}>
              {upcoming.map((b) => (
                <tr key={String(b["id"])}>
                  <td className="py-2 pr-4">
                    <Link
                      to="/events/bookings/$id"
                      params={{ id: String(b["id"]) }}
                      className="font-medium text-primary hover:underline"
                    >
                      {String(b["event_reference"])}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{String(b["event_name"] || "—")}</td>
                  <td className="py-2 pr-4">{formatDate(b["event_date"])}</td>
                  <td className="py-2 pr-4">
                    {String((b["event_venues"] as Row | null)?.["name"] ?? "—")}
                  </td>
                  <td className="py-2 pr-4">
                    {num(b["final_guests"]) ||
                      num(b["guaranteed_guests"]) ||
                      num(b["expected_guests"])}
                  </td>
                  <td className="py-2 pr-4">
                    <Pill tone={bookingTone(String(b["status"]))} value={String(b["status"])} />
                  </td>
                </tr>
              ))}
            </DataTable>
          </EventsQueryState>
        </SectionCard>

        <SectionCard
          title="Department readiness"
          description="Calculated from real department requirements and tasks"
        >
          <EventsQueryState
            isLoading={readiness.isLoading}
            error={readiness.error}
            isEmpty={readinessRows.length === 0}
            empty={
              <EventsEmpty
                title="No department requirements yet"
                description="Readiness appears once an event has department requirements assigned on its profile."
              />
            }
          >
            <div className="space-y-2">
              {readinessRows.slice(0, 10).map((r) => (
                <div
                  key={`${String(r["booking_id"])}-${String(r["department"])}`}
                  className="rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{String(r["department"])}</span>
                    <Pill tone={readinessTone(rollupState(r))} value={rollupState(r)} />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{String(r["event_reference"])}</span>
                    <span>
                      {num(r["ready"])}/{num(r["total"])} ready · {readinessPercent(r)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </EventsQueryState>
        </SectionCard>
      </div>

      <SectionCard title="Enquiry pipeline" description="Live enquiry stages">
        <EventsQueryState
          isLoading={enquiries.isLoading}
          error={enquiries.error}
          isEmpty={enquiryRows.length === 0}
          empty={
            <EventsEmpty
              title="No enquiries captured yet"
              description="Capture the first enquiry from the Enquiries tab."
            />
          }
        >
          <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {Object.entries(
              enquiryRows.reduce<Record<string, number>>((acc, e) => {
                const k = String(e["status"]);
                acc[k] = (acc[k] ?? 0) + 1;
                return acc;
              }, {}),
            ).map(([status, count]) => (
              <div key={status} className="rounded-lg border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">{titleCase(status)}</p>
                <p className="text-lg font-semibold">{count}</p>
              </div>
            ))}
          </div>
        </EventsQueryState>
      </SectionCard>

      <SectionCard
        title="AI Event Assistant — advisory only"
        description="Derived from your own event records. It never confirms bookings, approves discounts, moves stock or messages clients."
      >
        <div className="space-y-2">
          {advisoryInsights(bookingRows, symbol).map((i) => (
            <div key={i.title} className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className="text-sm font-medium">{i.title}</p>
              <p className="text-sm text-muted-foreground">{i.detail}</p>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  FormDialog,
  Pill,
  PropertyRequired,
  RecordForm,
} from "@/components/events/EventsShared";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { useTenant } from "@/lib/tenant";
import {
  BOOKING_STATUSES,
  SEATING_LAYOUTS,
  SERVICE_STYLES,
  bookingTone,
  formatDate,
  formatMoney,
  num,
  paymentTone,
  titleCase,
  type Row,
} from "@/lib/events";
import {
  useCreateBooking,
  useCustomersLite,
  useEventAttemptKey,
  useEventTypes,
  useEventWorkspace,
  useEventsCtx,
  useTransferBooking,
  useVenues,
} from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/bookings/")({
  head: () => ({
    meta: [
      { title: "Event Bookings — NEØ" },
      {
        name: "description",
        content:
          "Confirmed and provisional event bookings with venue holds, deposits and balances.",
      },
      { property: "og:title", content: "Event Bookings — NEØ" },
      {
        property: "og:description",
        content: "Confirmed and provisional event bookings with deposits and balances.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="bookings">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { can } = useAuth();
  const { branchId } = useEventsCtx();
  const { branches } = useBranchScope();
  const workspace = useEventWorkspace();
  const venues = useVenues();
  const customers = useCustomersLite();
  const types = useEventTypes();
  const create = useCreateBooking();
  const transfer = useTransferBooking();
  // One submission token per form attempt: every retry or double click of the
  // same attempt reuses it, and it rotates only on success or a new attempt.
  const attempt = useEventAttemptKey();

  const [transferFor, setTransferFor] = useState<{ id: string; reference: string } | null>(null);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");

  const rows = workspace.data ?? [];
  const canCreate = can("events", "bookings", "create");
  const canTransfer = can("events", "bookings", "transfer");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Event Bookings"
        description="Every event belongs to one property, keeps its own reference and carries its records with it."
        actions={
          canCreate && branchId ? (
            <FormDialog
              title="New event"
              description="Created at the property selected in the header. The reference is allocated by the system."
              onOpenChange={(open) => {
                // A deliberately new form attempt gets a fresh submission token.
                if (open) attempt.reset();
              }}
            >
              {(close) => (
                <RecordForm
                  submitLabel="Create event"
                  busy={create.isPending}
                  fields={[
                    { name: "event_name", label: "Event name", required: true, span: true },
                    {
                      name: "event_type_id",
                      label: "Event type",
                      type: "select",
                      options: ((types.data ?? []) as Row[]).map((t) => ({
                        value: String(t["id"]),
                        label: String(t["name"]),
                      })),
                    },
                    {
                      name: "customer_id",
                      label: "Client",
                      type: "select",
                      options: ((customers.data ?? []) as Row[]).map((c) => ({
                        value: String(c["id"]),
                        label: `${String(c["full_name"])} · ${String(c["customer_number"])}`,
                      })),
                    },
                    {
                      name: "venue_id",
                      label: "Venue",
                      type: "select",
                      options: ((venues.data ?? []) as Row[]).map((v) => ({
                        value: String(v["id"]),
                        label: String(v["name"]),
                      })),
                    },
                    { name: "event_date", label: "Event date", type: "date", required: true },
                    { name: "start_at", label: "Start", type: "datetime-local", required: true },
                    { name: "end_at", label: "End", type: "datetime-local", required: true },
                    { name: "setup_at", label: "Setup from", type: "datetime-local" },
                    { name: "breakdown_at", label: "Breakdown until", type: "datetime-local" },
                    { name: "expected_guests", label: "Expected guests", type: "number" },
                    { name: "guaranteed_guests", label: "Guaranteed guests", type: "number" },
                    {
                      name: "service_style",
                      label: "Service style",
                      type: "select",
                      options: SERVICE_STYLES.map((s) => ({ value: s, label: titleCase(s) })),
                    },
                    {
                      name: "seating_layout",
                      label: "Seating layout",
                      type: "select",
                      options: SEATING_LAYOUTS.map((s) => ({ value: s, label: titleCase(s) })),
                    },
                    { name: "deposit_required", label: "Deposit required", type: "number" },
                    { name: "total_amount", label: "Contract total", type: "number" },
                    {
                      name: "internal_notes",
                      label: "Internal notes",
                      type: "textarea",
                      span: true,
                    },
                  ]}
                  onSubmit={(values) =>
                    create.mutate(
                      { ...values, status: "tentative", idempotency_key: attempt.key },
                      {
                        onSuccess: () => {
                          attempt.reset();
                          close();
                        },
                      },
                    )
                  }
                />
              )}
            </FormDialog>
          ) : null
        }
      />

      {canCreate && !branchId ? <PropertyRequired what="An event" /> : null}

      <SectionCard
        title="All events"
        description={`${rows.length} events for the selected property`}
      >
        <EventsQueryState
          isLoading={workspace.isLoading}
          error={workspace.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No events yet"
              description="Convert an accepted quotation, or create an event to start planning."
            />
          }
        >
          <DataTable
            head={[
              "Reference",
              "Event",
              "Property",
              "Client",
              "Date",
              "Venue",
              "Guests",
              "Status",
              "Payment",
              "Balance",
              "",
            ]}
          >
            {rows.map((b) => (
              <tr key={b.booking_id}>
                <td className="py-2 pr-4 font-medium">{b.event_reference}</td>
                <td className="py-2 pr-4">{b.event_name ?? "—"}</td>
                <td className="py-2 pr-4">{b.branch_name ?? "—"}</td>
                <td className="py-2 pr-4">{b.customer_name ?? "—"}</td>
                <td className="py-2 pr-4">{formatDate(b.event_date)}</td>
                <td className="py-2 pr-4">{b.venue_name ?? "—"}</td>
                <td className="py-2 pr-4">
                  {num(b.final_guests) || num(b.guaranteed_guests) || num(b.expected_guests)}
                </td>
                <td className="py-2 pr-4">
                  <Pill tone={bookingTone(b.status)} value={b.status} />
                </td>
                <td className="py-2 pr-4">
                  <Pill
                    tone={paymentTone(String(b.payment_status ?? "unpaid"))}
                    value={String(b.payment_status ?? "unpaid")}
                  />
                </td>
                <td className="py-2 pr-4">{formatMoney(symbol, b.balance_due)}</td>
                <td className="space-x-2 whitespace-nowrap py-2 pr-4">
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/events/bookings/$id" params={{ id: b.booking_id }}>
                      Open
                    </Link>
                  </Button>
                  {canTransfer ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setTransferFor({ id: b.booking_id, reference: b.event_reference });
                        setTarget("");
                        setReason("");
                      }}
                    >
                      Transfer
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard title="Event statuses" description="Lifecycle used across the module">
        <div className="flex flex-wrap gap-2">
          {BOOKING_STATUSES.map((s) => (
            <Pill key={s} tone={bookingTone(s)} value={s} />
          ))}
        </div>
      </SectionCard>

      <Dialog open={transferFor !== null} onOpenChange={(o) => !o && setTransferFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer {transferFor?.reference}</DialogTitle>
            <DialogDescription>
              The event and all of its billing, readiness, banquet order and feedback records move
              together. The reason is recorded on the event history.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Destination property</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select property…" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Reason</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this event moving?"
              />
            </div>
            <Button
              disabled={!target || reason.trim().length === 0 || transfer.isPending}
              onClick={() =>
                transferFor &&
                transfer.mutate(
                  { bookingId: transferFor.id, branchId: target, reason: reason.trim() },
                  { onSuccess: () => setTransferFor(null) },
                )
              }
            >
              Transfer event
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

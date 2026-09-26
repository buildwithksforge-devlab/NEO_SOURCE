/**
 * Banquet payment entry.
 *
 * One screen where the desk enters what was actually taken for an event: cash,
 * card and M-Pesa side by side, each with its own reference. Every tender is
 * recorded as its own entry against the event bill, so reconciliation shows the
 * real split rather than one lump figure. The browser never sums the bill —
 * charged, received and outstanding all come from the database statement.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Banknote } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { EventsEmpty, EventsGuard, EventsQueryState, Pill } from "@/components/events/EventsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTenant } from "@/lib/tenant";
import { formatDate, formatMoney, paymentTone, titleCase } from "@/lib/events";
import { useBookings, useEventBillStatement, useRecordEventPayment } from "@/lib/events-data";
import { useMyOpenShift } from "@/lib/pos-data";
import { useShiftExpected } from "@/lib/frontdesk-ops";
import { useQueryClient } from "@tanstack/react-query";
import type { Row } from "@/lib/events";

export const Route = createFileRoute("/_shell/events/payments")({
  head: () => ({
    meta: [
      { title: "Banquet Payments — NEØ" },
      {
        name: "description",
        content: "Enter banquet cash, card and M-Pesa receipts with their references against the event bill.",
      },
      { property: "og:title", content: "Banquet Payments — NEØ" },
      {
        property: "og:description",
        content: "Record real banquet money by tender, each with its own reference.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="billing" action="create">
      <Page />
    </EventsGuard>
  ),
});

type TenderKey = "cash" | "card" | "mpesa";

const TENDERS: { key: TenderKey; label: string; referenceHint: string; referenceRequired: boolean }[] = [
  { key: "cash", label: "Cash", referenceHint: "Receipt or till number", referenceRequired: false },
  { key: "card", label: "Card", referenceHint: "Terminal approval code", referenceRequired: true },
  { key: "mpesa", label: "M-Pesa", referenceHint: "M-Pesa transaction code", referenceRequired: true },
];

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const bookings = useBookings();
  const record = useRecordEventPayment();

  const [bookingId, setBookingId] = useState<string | null>(null);
  const [entryType, setEntryType] = useState("payment");
  const [amounts, setAmounts] = useState<Record<TenderKey, string>>({ cash: "", card: "", mpesa: "" });
  const [references, setReferences] = useState<Record<TenderKey, string>>({ cash: "", card: "", mpesa: "" });
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Partial<Record<TenderKey | "booking", string>>>({});

  // The till the cashier has open. Cash taken for an event lands in this
  // drawer, so the expected balance is read straight back from the database
  // after every entry rather than added up in the browser.
  const qc = useQueryClient();
  const myShift = useMyOpenShift();
  const shiftId = (myShift.data as { id?: string } | null)?.id ?? null;
  const shiftNumber = (myShift.data as { shift_number?: string } | null)?.shift_number ?? null;
  const tillExpected = useShiftExpected(shiftId);

  const statement = useEventBillStatement(bookingId);
  const totals = statement.data?.totals;
  const booking = statement.data?.booking;

  const rows = (bookings.data ?? []) as Row[];
  const options = useMemo(
    () =>
      rows
        .filter((b) => !["cancelled", "enquiry"].includes(String(b["status"] ?? "")))
        .map((b) => ({
          id: String(b["id"]),
          label: `${String(b["event_reference"] ?? "—")} · ${String(b["event_name"] ?? "Event")}`,
          date: b["event_date"],
          paymentStatus: String(b["payment_status"] ?? "unpaid"),
        })),
    [rows],
  );

  const entered = TENDERS.reduce((sum, t) => sum + (Number(amounts[t.key]) || 0), 0);

  const submit = async () => {
    const next: Partial<Record<TenderKey | "booking", string>> = {};
    if (!bookingId) next.booking = "Choose the event this money belongs to.";

    const payable = TENDERS.filter((t) => amounts[t.key].trim() !== "");
    for (const tender of payable) {
      const value = Number(amounts[tender.key]);
      if (Number.isNaN(value) || value <= 0) {
        next[tender.key] = "Enter an amount greater than zero.";
        continue;
      }
      if (tender.referenceRequired && !references[tender.key].trim()) {
        next[tender.key] = `A ${tender.label} reference is required.`;
      }
    }
    if (payable.length === 0) next.cash = "Enter at least one amount.";

    setErrors(next);
    if (Object.keys(next).length > 0 || !bookingId) return;

    let posted = 0;
    for (const tender of payable) {
      const result = (await record.mutateAsync({
        bookingId,
        amount: Number(amounts[tender.key]),
        entryType,
        method: tender.key,
        reference: references[tender.key].trim() || undefined,
        reason: note.trim() || undefined,
      })) as { ok?: boolean; reason?: string; detail?: string };
      if (result?.ok === false) {
        setErrors({ [tender.key]: result.detail ?? "That entry was refused." });
        toast.error(result.detail ?? "That entry was refused.");
        break;
      }
      posted += 1;
    }
    if (posted === 0) return;
    void qc.invalidateQueries({ queryKey: ["pos", "shift-expected", shiftId] });
    setAmounts({ cash: "", card: "", mpesa: "" });
    setReferences({ cash: "", card: "", mpesa: "" });
    setNote("");
    toast.success(`${posted} ${posted === 1 ? "receipt" : "receipts"} recorded against the event bill.`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Banknote}
        eyebrow="Events"
        title="Banquet payments"
        description="Record what was actually taken for an event — cash, card and M-Pesa, each with its own reference."
      />

      <SectionCard
        title="Your till"
        description="Cash taken for an event goes into this drawer — the balance updates as you record money."
      >
        {shiftId ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Till session" value={shiftNumber ?? "Open"} />
            <StatCard
              label="Expected in drawer"
              value={
                tillExpected.isLoading
                  ? "…"
                  : formatMoney(symbol, Number(tillExpected.data ?? 0))
              }
            />
            <StatCard
              label="Opening float"
              value={formatMoney(symbol, Number((myShift.data as { opening_float?: number } | null)?.opening_float ?? 0))}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No till is open for you. Card and M-Pesa can still be recorded; cash needs an open till so the
            drawer reconciles at the end of the shift.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Event" description="Choose the event, then enter the money exactly as it was taken.">
        <EventsQueryState
          query={bookings}
          isLoading={bookings.isLoading}
          error={bookings.error}
          isEmpty={options.length === 0}
          empty={<EventsEmpty title="No events yet" description="Confirmed events appear here for payment entry." />}
        >
          <div className="space-y-4">
            <div className="space-y-1.5 sm:max-w-lg">
              <Label>Event</Label>
              <Select value={bookingId ?? ""} onValueChange={(v) => setBookingId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an event" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.booking ? <p className="text-xs text-destructive">{errors.booking}</p> : null}
            </div>

            {bookingId ? (
              <div className="grid gap-3 sm:grid-cols-4">
                <StatCard label="Charged" value={formatMoney(symbol, Number(totals?.charged ?? 0))} />
                <StatCard label="Received" value={formatMoney(symbol, Number(totals?.paid ?? 0))} />
                <StatCard
                  label="Outstanding"
                  value={formatMoney(symbol, Number(totals?.outstanding ?? 0))}
                  tone={Number(totals?.outstanding ?? 0) > 0 ? "warning" : "default"}
                />
                <StatCard
                  label="Event date"
                  value={booking?.event_date ? formatDate(booking.event_date) : "—"}
                />
              </div>
            ) : null}
          </div>
        </EventsQueryState>
      </SectionCard>

      <SectionCard
        title="Money taken"
        description="Leave a tender blank if none was taken that way. Card and M-Pesa need their transaction reference."
      >
        <div className="space-y-4">
          <div className="space-y-1.5 sm:max-w-xs">
            <Label>Entry type</Label>
            <Select value={entryType} onValueChange={setEntryType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["deposit", "payment"].map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {TENDERS.map((tender) => (
            <div key={tender.key} className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`amount-${tender.key}`}>{tender.label} amount</Label>
                <Input
                  id={`amount-${tender.key}`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amounts[tender.key]}
                  onChange={(e) => setAmounts((prev) => ({ ...prev, [tender.key]: e.target.value }))}
                />
                {errors[tender.key] ? (
                  <p className="text-xs text-destructive">{errors[tender.key]}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`ref-${tender.key}`}>
                  {tender.label} reference {tender.referenceRequired ? "(required)" : "(optional)"}
                </Label>
                <Input
                  id={`ref-${tender.key}`}
                  placeholder={tender.referenceHint}
                  value={references[tender.key]}
                  onChange={(e) => setReferences((prev) => ({ ...prev, [tender.key]: e.target.value }))}
                />
              </div>
            </div>
          ))}

          <div className="space-y-1.5">
            <Label htmlFor="payment-note">Note (optional)</Label>
            <Textarea id="payment-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={record.isPending || !bookingId} onClick={() => void submit()}>
              {record.isPending ? "Recording…" : `Record ${formatMoney(symbol, entered)}`}
            </Button>
            {booking ? (
              <Pill tone={paymentTone(String(booking.billing_status ?? "not_billed"))} value={String(booking.billing_status ?? "not_billed")} />
            ) : null}
          </div>
        </div>
      </SectionCard>

      {bookingId ? (
        <SectionCard title="Already recorded" description="Every entry taken against this event, newest last.">
          <EventsQueryState
            query={statement}
            isLoading={statement.isLoading}
            error={statement.error}
            isEmpty={(statement.data?.payments ?? []).length === 0}
            empty={<EventsEmpty title="Nothing recorded yet" description="Entries you record appear here at once." />}
          >
            <ul className="space-y-1 text-sm">
              {(statement.data?.payments ?? []).map((p) => (
                <li key={p.id} className="flex items-center justify-between border-b border-border/40 py-1.5">
                  <span>
                    {titleCase(p.entry_type)} · {titleCase(p.method)}
                    {p.reference ? <span className="text-muted-foreground"> · {p.reference}</span> : null}
                    {p.receipt_number ? (
                      <span className="text-muted-foreground"> · Receipt {p.receipt_number}</span>
                    ) : null}
                  </span>
                  <span className="font-medium">{formatMoney(symbol, Number(p.amount))}</span>
                </li>
              ))}
            </ul>
          </EventsQueryState>
        </SectionCard>
      ) : null}
    </div>
  );
}

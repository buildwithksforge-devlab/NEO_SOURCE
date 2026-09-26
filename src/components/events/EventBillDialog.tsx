import { useState } from "react";
import { RefreshCw, Lock, Unlock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { methodsFor, PaymentMethodPicker } from "@/components/payments/PaymentMethodPicker";
import { ReceivingAccountSelect } from "@/components/payments/ReceivingAccountSelect";
import { useAuth } from "@/lib/auth";
import { formatDate, formatMoney, titleCase } from "@/lib/events";
import {
  useBuildEventBill,
  useEventBillStatement,
  useFinaliseEventBill,
  useRecordEventPayment,
  useReopenEventBill,
} from "@/lib/events-data";

const ENTRY_TYPES = ["deposit", "payment", "refund", "credit", "adjustment"];
/** Events collect the same tenders as every other desk, from the one catalogue. */
const EVENT_METHODS = methodsFor([
  "cash",
  "card",
  "card-terminal",
  "mpesa",
  "qr",
  "bank-transfer",
  "corporate-credit",
  "voucher",
]);

function statusTone(status: string): "default" | "secondary" | "outline" {
  if (status === "finalised") return "default";
  if (status === "draft") return "secondary";
  return "outline";
}

/**
 * The authoritative bill for one event. Every figure here is computed by the
 * database from the event's own records — the browser never sums money.
 */
export function EventBillDialog({
  bookingId,
  symbol,
  open,
  onOpenChange,
}: {
  bookingId: string | null;
  symbol: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { can } = useAuth();
  const statement = useEventBillStatement(open ? bookingId : null);
  const build = useBuildEventBill();
  const record = useRecordEventPayment();
  const finalise = useFinaliseEventBill();
  const reopen = useReopenEventBill();

  const [entryType, setEntryType] = useState("payment");
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  // Method is how it was paid; this is which hotel account received it.
  const [account, setAccount] = useState<string | null>(null);

  const data = statement.data;
  const booking = data?.booking;
  const totals = data?.totals;
  const billingStatus = booking?.billing_status ?? "not_billed";
  const finalised = billingStatus === "finalised";
  const canCreate = can("events", "billing", "create");
  const canApprove = can("events", "billing", "approve");
  const busy = build.isPending || record.isPending || finalise.isPending || reopen.isPending;

  const submitEntry = () => {
    if (!bookingId) return;
    record.mutate(
      {
        bookingId,
        amount: Number(amount),
        entryType,
        method,
        reference: reference.trim() || undefined,
        reason: reason.trim() || undefined,
        destinationAccountId: account,
      },
      {
        onSuccess: () => {
          setAmount("");
          setReference("");
          setReason("");
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {booking ? `${booking.reference} — ${booking.name ?? "Event bill"}` : "Event bill"}
          </DialogTitle>
          <DialogDescription>
            Built from the event's menus, resources, vendors and approved changes. Finance may only
            recognise a finalised bill.
          </DialogDescription>
        </DialogHeader>

        {statement.isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : statement.error ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {(statement.error as Error).message}
          </p>
        ) : !booking ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This event bill is not available.
          </p>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusTone(billingStatus)}>
                {titleCase(billingStatus.replace("_", " "))}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Event {formatDate(booking.event_date)}
              </span>
              {booking.generated_at ? (
                <span className="text-xs text-muted-foreground">
                  · built {formatDate(booking.generated_at)}
                </span>
              ) : null}
              {booking.billed_at ? (
                <span className="text-xs text-muted-foreground">
                  · finalised {formatDate(booking.billed_at)}
                </span>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              {[
                ["Charged", totals?.charged ?? 0],
                ["Complimentary", totals?.complimentary ?? 0],
                ["Received", totals?.paid ?? 0],
                ["Outstanding", totals?.outstanding ?? 0],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-border/60 p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-lg font-semibold">{formatMoney(symbol, Number(value))}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              {canCreate ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || finalised}
                  onClick={() => bookingId && build.mutate({ bookingId })}
                >
                  <RefreshCw className="mr-2 size-4" /> Rebuild from event records
                </Button>
              ) : null}
              {canApprove && !finalised ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => bookingId && finalise.mutate({ bookingId })}
                >
                  <Lock className="mr-2 size-4" /> Finalise bill
                </Button>
              ) : null}
              {canApprove && finalised ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !reason.trim()}
                  onClick={() => bookingId && reopen.mutate({ bookingId, reason: reason.trim() })}
                >
                  <Unlock className="mr-2 size-4" /> Reopen (reason required)
                </Button>
              ) : null}
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold">Bill lines</h4>
              {(data?.lines ?? []).length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
                  No billable positions yet. Rebuild once menus, resources or vendors are attached.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-1 text-left">Category</th>
                      <th className="py-1 text-left">Description</th>
                      <th className="py-1 text-right">Qty</th>
                      <th className="py-1 text-right">Unit</th>
                      <th className="py-1 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.lines ?? []).map((l) => (
                      <tr key={l.id} className="border-t border-border/50">
                        <td className="py-1.5">{titleCase(l.category)}</td>
                        <td className="py-1.5">
                          {l.description ?? "—"}
                          {l.complimentary ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              complimentary
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1.5 text-right">{l.quantity ?? 0}</td>
                        <td className="py-1.5 text-right">
                          {formatMoney(symbol, Number(l.unit_price ?? 0))}
                        </td>
                        <td className="py-1.5 text-right font-medium">
                          {formatMoney(symbol, Number(l.line_total ?? 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold">Money received</h4>
              {(data?.payments ?? []).length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
                  Nothing recorded against this event yet.
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {(data?.payments ?? []).map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between border-b border-border/40 py-1.5"
                    >
                      <span>
                        {titleCase(p.entry_type)} · {titleCase(p.method)}
                        {p.reference ? (
                          <span className="text-muted-foreground"> · {p.reference}</span>
                        ) : null}
                        {p.reason ? (
                          <span className="text-muted-foreground"> — {p.reason}</span>
                        ) : null}
                      </span>
                      <span className="font-medium">{formatMoney(symbol, Number(p.amount))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {canCreate ? (
              <div className="rounded-xl border border-border/60 p-4">
                <h4 className="mb-3 text-sm font-semibold">Record an entry</h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Entry type</Label>
                    <Select value={entryType} onValueChange={setEntryType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ENTRY_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {titleCase(t)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <PaymentMethodPicker
                      methods={EVENT_METHODS}
                      value={method}
                      onChange={setMethod}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Amount</Label>
                    <Input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      inputMode="decimal"
                      placeholder="0.00"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Reference</Label>
                    <Input
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      placeholder="Receipt or transaction ref"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <ReceivingAccountSelect
                      id="event-receiving-account"
                      value={account}
                      onChange={setAccount}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>
                      Reason{" "}
                      {["refund", "credit", "adjustment"].includes(entryType)
                        ? "(required)"
                        : "(optional)"}
                    </Label>
                    <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
                  </div>
                </div>
                <Button
                  className="mt-3"
                  size="sm"
                  disabled={busy || !amount.trim() || Number.isNaN(Number(amount))}
                  onClick={submitEntry}
                >
                  Record entry
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

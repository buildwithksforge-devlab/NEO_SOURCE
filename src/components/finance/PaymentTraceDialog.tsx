import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/common/DataDisplay";
import { money } from "@/lib/finance";
import { usePaymentTrace } from "@/lib/cash-routing";

/**
 * One payment, end to end.
 *
 * Folio or order → cash request → cashier confirmation → till session →
 * receipt → Finance posting → journal → audit history, all read from the same
 * records the money moved through, so the story can never disagree with itself.
 */
export function PaymentTraceDialog({
  paymentId,
  onOpenChange,
}: {
  paymentId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const trace = usePaymentTrace(paymentId);
  const t = trace.data;

  return (
    <Dialog open={Boolean(paymentId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Payment trace</DialogTitle>
          <DialogDescription>
            Every step this money passed through, from the till that received it to the journal it
            became.
          </DialogDescription>
        </DialogHeader>

        {trace.isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" aria-label="Loading payment trace" />
        ) : trace.error || !t ? (
          <p className="text-sm text-destructive">
            This payment could not be traced, so nothing is shown rather than a partial story.
          </p>
        ) : (
          <div className="space-y-4 text-sm">
            <Step title="Receipt">
              <p className="text-base font-semibold">{money(t.payment.amount)}</p>
              <p className="text-xs text-muted-foreground">
                {t.payment.receipt_number ?? "No receipt number"} ·{" "}
                {t.payment.method ?? "—"} · {t.payment.status ?? "—"}
                {t.payment.paid_at ? ` · ${new Date(t.payment.paid_at).toLocaleString()}` : ""}
              </p>
            </Step>

            <Step title="Cash request">
              {t.request ? (
                <p className="text-xs text-muted-foreground">
                  Raised from {t.request.source_module ?? "billing"} · {t.request.status}
                  {t.request.confirmed_at
                    ? ` · confirmed ${new Date(t.request.confirmed_at).toLocaleString()}`
                    : ""}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Taken directly, without a routed cash request.
                </p>
              )}
            </Step>

            <Step title="Till session">
              {t.till ? (
                <p className="text-xs text-muted-foreground">
                  {t.till.shift_number ?? t.till.shift_id.slice(0, 8)} · {t.till.status} · opened{" "}
                  {new Date(t.till.opened_at).toLocaleString()}
                  {t.till.closed_at
                    ? ` · closed ${new Date(t.till.closed_at).toLocaleString()}`
                    : ""}
                  {t.till.variance !== null ? ` · variance ${money(t.till.variance)}` : ""}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No till session is attached to this payment.
                </p>
              )}
            </Step>

            <Step title="Finance posting">
              {t.posting ? (
                <p className="text-xs text-muted-foreground">
                  <StatusPill tone={t.posting.status === "posted" ? "success" : "warning"}>
                    {t.posting.status}
                  </StatusPill>{" "}
                  {t.posting.posting_type ?? ""}
                  {t.posting.attempts ? ` · ${t.posting.attempts} attempt(s)` : ""}
                  {t.posting.last_error ? ` · ${t.posting.last_error}` : ""}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No Finance posting has been raised for this payment yet.
                </p>
              )}
            </Step>

            <Step title="Journal">
              {t.journal ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {t.journal.journal_number ?? "—"} · {t.journal.status} ·{" "}
                    {t.journal.accounting_date ?? "—"} · debits {money(t.journal.total_debit)} /
                    credits {money(t.journal.total_credit)}
                  </p>
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-1">Account</th>
                        <th className="py-1 text-right">Debit</th>
                        <th className="py-1 text-right">Credit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {t.journal.lines.map((l, i) => (
                        <tr key={`${l.account_code ?? i}-${i}`}>
                          <td className="py-1">
                            {l.account_code ?? "—"} {l.account_name ?? ""}
                          </td>
                          <td className="py-1 text-right tabular-nums">{money(l.debit ?? 0)}</td>
                          <td className="py-1 text-right tabular-nums">{money(l.credit ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No journal has been written for this payment.
                </p>
              )}
            </Step>

            <Step title="Audit history">
              {t.audit.length === 0 ? (
                <p className="text-xs text-muted-foreground">No audit entries recorded.</p>
              ) : (
                <ul className="space-y-1">
                  {t.audit.map((a) => (
                    <li key={a.id} className="text-xs text-muted-foreground">
                      {new Date(a.created_at).toLocaleString()} · {a.action} ·{" "}
                      {a.user_name ?? "System"}
                      {a.reason ? ` · ${a.reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </Step>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border p-3">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

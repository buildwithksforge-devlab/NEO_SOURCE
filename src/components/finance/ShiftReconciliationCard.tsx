import { useState } from "react";
import { Receipt } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { FinanceEmpty } from "@/components/finance/FinanceShared";
import { PaymentTraceDialog } from "@/components/finance/PaymentTraceDialog";
import { money } from "@/lib/finance";
import { useRequestCashRefund, useShiftReconciliation } from "@/lib/cash-routing";

/**
 * End-of-shift reconciliation.
 *
 * The expected figure is not an opinion: it is the opening float plus every
 * confirmed receipt, less drops, paid-outs and refunds. Each line names the
 * receipt behind it and the Finance journal it became, so a variance is traced
 * to exact money rather than argued about.
 */
export function ShiftReconciliationCard({ shiftId }: { shiftId: string | null }) {
  const recon = useShiftReconciliation(shiftId);
  const [trace, setTrace] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<{ id: string; receipt: string; amount: number } | null>(
    null,
  );
  const d = recon.data;

  if (!shiftId) return null;

  return (
    <SectionCard
      title="Shift reconciliation"
      description="Everything behind the expected cash for this session, each line linked to its receipt and Finance journal."
    >
      {recon.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" aria-label="Loading shift reconciliation" />
      ) : recon.error || !d ? (
        <p className="text-sm text-destructive">
          This session could not be reconciled, so no figures are shown.
        </p>
      ) : (
        <div className="space-y-4 text-sm">
          <dl className="grid gap-3 sm:grid-cols-4">
            <Fact label="Opening float" value={money(d.opening_float)} />
            <Fact label="Drops & paid-outs" value={money(d.total_drops + d.total_paid_outs)} />
            <Fact label="Expected now" value={money(d.expected_cash)} />
            <Fact
              label="Variance"
              value={d.variance === null ? "Not yet declared" : money(d.variance)}
            />
          </dl>

          <Lines title="Folio and room receipts">
            {d.folio_receipts.length === 0 ? (
              <FinanceEmpty
                title="No folio receipts"
                description="Confirmed cash against folios will list here."
              />
            ) : (
              d.folio_receipts.map((r) => (
                <Row
                  key={r.payment_id}
                  amount={r.amount}
                  primary={r.receipt_number ?? r.payment_id.slice(0, 8)}
                  secondary={`${new Date(r.paid_at).toLocaleString()} · ${r.method}`}
                  journal={r.journal_number}
                  posting={r.posting_status}
                  onTrace={() => setTrace(r.payment_id)}
                  onRefund={() =>
                    setRefundFor({
                      id: r.payment_id,
                      receipt: r.receipt_number ?? r.payment_id.slice(0, 8),
                      amount: r.amount,
                    })
                  }
                />
              ))
            )}
          </Lines>

          <Lines title="POS receipts">
            {d.pos_receipts.length === 0 ? (
              <FinanceEmpty
                title="No POS receipts"
                description="Confirmed cash against POS bills will list here."
              />
            ) : (
              d.pos_receipts.map((r) => (
                <Row
                  key={r.payment_id}
                  amount={r.amount}
                  primary={r.receipt_number ?? r.payment_id.slice(0, 8)}
                  secondary={new Date(r.paid_at).toLocaleString()}
                  journal={r.journal_number}
                  posting={r.posting_status}
                  onTrace={() => setTrace(r.payment_id)}
                  onRefund={() =>
                    setRefundFor({
                      id: r.payment_id,
                      receipt: r.receipt_number ?? r.payment_id.slice(0, 8),
                      amount: r.amount,
                    })
                  }
                />
              ))
            )}
          </Lines>

          {d.refunds.length > 0 ? (
            <Lines title="Refunds paid out">
              {d.refunds.map((r) => (
                <Row
                  key={r.id}
                  amount={-r.amount}
                  primary={`${r.refund_receipt_number ?? "—"} against ${r.original_receipt_number ?? "—"}`}
                  secondary={r.reason}
                  {...(r.refund_receipt_number ? {} : {})}
                />
              ))}
            </Lines>
          ) : null}

          {d.transfers_out.length > 0 || d.transfers_in.length > 0 ? (
            <Lines title="Transfers">
              {[...d.transfers_out, ...d.transfers_in].map((t) => (
                <Row
                  key={t.id}
                  amount={t.amount}
                  primary={t.transfer_number}
                  secondary={t.status === "in_transit" ? "Awaiting confirmation" : t.status}
                />
              ))}
            </Lines>
          ) : null}

          {d.movements.length > 0 ? (
            <Lines title="Movements">
              {d.movements.map((m) => (
                <Row
                  key={m.id}
                  amount={m.amount}
                  primary={m.type.replace(/_/g, " ")}
                  secondary={`${new Date(m.created_at).toLocaleString()}${m.reason ? ` · ${m.reason}` : ""}`}
                />
              ))}
            </Lines>
          ) : null}
        </div>
      )}

      <PaymentTraceDialog paymentId={trace} onOpenChange={(o) => !o && setTrace(null)} />
      <RefundDialog target={refundFor} onOpenChange={(o) => !o && setRefundFor(null)} />
    </SectionCard>
  );
}

function RefundDialog({
  target,
  onOpenChange,
}: {
  target: { id: string; receipt: string; amount: number } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const raise = useRequestCashRefund();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(o) => {
        if (!o) {
          setAmount("");
          setReason("");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund receipt {target?.receipt}</DialogTitle>
          <DialogDescription>
            The refund is linked to this receipt. Above the configured threshold it must be
            authorised by someone else before any cash leaves the drawer.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="refund-amount">Amount (max {money(target?.amount ?? 0)})</Label>
            <Input
              id="refund-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="refund-reason">Reason</Label>
            <Input
              id="refund-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this money going back?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={
              !target ||
              Number(amount) <= 0 ||
              Number(amount) > (target?.amount ?? 0) + 0.009 ||
              reason.trim().length < 3 ||
              raise.isPending
            }
            onClick={() =>
              target &&
              raise.mutate(
                { payment: target.id, amount: Number(amount), reason: reason.trim() },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Raise refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-[0.68rem] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Lines({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({
  amount,
  primary,
  secondary,
  journal,
  posting,
  onTrace,
  onRefund,
}: {
  amount: number;
  primary: string;
  secondary?: string;
  journal?: string | null;
  posting?: string | null;
  onTrace?: () => void;
  onRefund?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Receipt className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium">{primary}</span>
          <span className="tabular-nums">{money(amount)}</span>
          {journal ? (
            <StatusPill tone="success">Journal {journal}</StatusPill>
          ) : posting ? (
            <StatusPill tone="warning">{posting}</StatusPill>
          ) : null}
        </div>
        {secondary ? <p className="text-xs text-muted-foreground">{secondary}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        {onRefund ? (
          <Button size="sm" variant="outline" onClick={onRefund}>
            Refund
          </Button>
        ) : null}
        {onTrace ? (
          <Button size="sm" variant="outline" onClick={onTrace}>
            Trace
          </Button>
        ) : null}
      </div>
    </div>
  );
}

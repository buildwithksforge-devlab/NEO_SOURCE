import { useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { usePosRefundPosition, useRequestRefund, type RefundPayment } from "@/lib/pos-refunds";
import { money, titleCase } from "@/lib/pos";
const tenders = [
  "cash",
  "mpesa",
  "card",
  "card-terminal",
  "debit-card",
  "credit-card",
  "qr",
  "bank-transfer",
];
export function PosRefundPanel({ orderId }: { orderId: string }) {
  const { can, isAdmin } = useAuth();
  const position = usePosRefundPosition(orderId),
    request = useRequestRefund();
  const [selected, setSelected] = useState<RefundPayment | null>(null),
    [amount, setAmount] = useState(""),
    [reason, setReason] = useState(""),
    [attempt, setAttempt] = useState(""),
    [problem, setProblem] = useState<string | null>(null);
  const permitted =
    isAdmin ||
    can("pos", "refunds", "request") ||
    can("finance", "till", "confirm_cash") ||
    can("pos", "payments", "record");
  const valid =
    Number.isFinite(Number(amount)) &&
    Number(amount) > 0 &&
    Math.abs(Math.round(Number(amount) * 100) - Number(amount) * 100) < 0.000001 &&
    Number(amount) <= Number(selected?.refundable ?? 0) &&
    reason.trim().length >= 3;
  const close = () => {
    if (!request.isPending) {
      setSelected(null);
      setProblem(null);
    }
  };
  return (
    <SectionCard
      title="Refunds"
      description="Approval and payout are separate. Returned money is recorded against the original receipt; item cancellation and stock effects follow the void workflow."
    >
      {position.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading saved refund amounts…</p>
      ) : position.isError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{position.error.message}</p>
          <Button variant="outline" onClick={() => void position.refetch()}>
            Reload refund amounts
          </Button>
        </div>
      ) : !position.data?.payments.length ? (
        <p className="text-sm text-muted-foreground">
          Confirmed receipts will appear here. A payout requires matching posted Finance evidence.
        </p>
      ) : (
        <div className="space-y-3">
          {position.data.payments.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="text-sm">
                <p className="font-medium">
                  {p.receipt_number ?? "Receipt"} · {titleCase(p.method)}
                </p>
                <p>
                  Original {money(p.amount)} · Refunded {money(p.refunded)} · Awaiting
                  decision/payout {money(Math.max(0, Number(p.reserved) - Number(p.refunded)))}
                </p>
                {p.legacy_review ? (
                  <p className="text-warning">
                    An earlier refund request needs evidence review before another request.
                  </p>
                ) : null}
              </div>
              {permitted &&
              p.status === "confirmed" &&
              Number.isFinite(Number(p.refundable)) &&
              Number(p.refundable) > 0 &&
              tenders.includes(p.method) &&
              !p.legacy_review ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelected(p);
                    setAmount("");
                    setReason("");
                    setAttempt(crypto.randomUUID());
                    setProblem(null);
                  }}
                >
                  Request refund
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a receipt refund</DialogTitle>
            <DialogDescription>
              Up to {money(selected?.refundable ?? 0)} remains unreserved on this receipt. A
              different authorised person must approve; this action does not pay money.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="pos-refund-amount">Refund amount</Label>
            <Input
              id="pos-refund-amount"
              inputMode="decimal"
              value={amount}
              disabled={request.isPending}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Label htmlFor="pos-refund-reason">Reason</Label>
            <Input
              id="pos-refund-reason"
              value={reason}
              maxLength={500}
              disabled={request.isPending}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={request.isPending} onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={!valid || request.isPending}
              onClick={async () => {
                if (!selected) return;
                try {
                  setProblem(null);
                  await request.mutateAsync({
                    orderId,
                    paymentId: selected.id,
                    amount: Number(amount),
                    reason: reason.trim(),
                    attempt,
                  });
                  setSelected(null);
                } catch (e) {
                  setProblem(e instanceof Error ? e.message : "Refund request failed.");
                }
              }}
            >
              {request.isPending ? "Saving request…" : "Send for approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

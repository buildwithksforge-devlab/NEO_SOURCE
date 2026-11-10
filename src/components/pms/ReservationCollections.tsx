import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { PAYMENT_METHOD_CATALOGUE, normalisePaymentMethod } from "@/lib/payment-methods";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useConfirmReservationPayment,
  useReservationCollections,
  type ReservationCollection,
} from "@/lib/reservation-collections";
import { moneyWithCode, formatDateTime, titleCase } from "@/lib/pms";
export function ReservationCollections({
  reservationId,
  folioIds,
}: {
  reservationId: string;
  folioIds: string[];
}) {
  const history = useReservationCollections(reservationId, folioIds),
    confirm = useConfirmReservationPayment();
  const { can } = useAuth();
  const [selected, setSelected] = useState<ReservationCollection | null>(null),
    [reference, setReference] = useState(""),
    [note, setNote] = useState(""),
    [error, setError] = useState<string | null>(null);
  const mayConfirm = (row: ReservationCollection) =>
    row.kind === "payment" &&
    row.state === "Awaiting confirmation" &&
    (can("pms", "payments.confirm") || can("finance", "approve")) &&
    PAYMENT_METHOD_CATALOGUE.some(
      (m) => m.value === normalisePaymentMethod(row.method) && m.kind === "recorded",
    );
  if (history.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading collections…
      </p>
    );
  if (history.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {history.error.message}
      </p>
    );
  if (!history.data?.length)
    return (
      <p className="text-sm text-muted-foreground">
        No deposits or payments recorded for this reservation.
      </p>
    );
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Deposits and payments across this reservation's folios. Applying a deposit is not another
        collection. Pending payments have not reduced the balance.
      </p>
      <ul className="space-y-2 text-sm">
        {history.data.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap justify-between gap-2 rounded-lg border border-border/70 p-3"
          >
            <div>
              <p className="font-medium">
                {row.kind === "deposit" ? "Reservation deposit" : "Payment"} ·{" "}
                {titleCase(row.method)}
              </p>
              <p className="text-xs text-muted-foreground">
                {row.state}
                {row.reference ? " · " + row.reference : ""}
                {row.receivedAt ? " · " + formatDateTime(row.receivedAt) : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{moneyWithCode(row.amount, row.currency)}</span>
              {mayConfirm(row) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelected(row);
                    setReference("");
                    setNote("");
                    setError(null);
                  }}
                >
                  Review confirmation
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !confirm.isPending) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm recorded payment</DialogTitle>
            <DialogDescription>
              Confirm only after checking that this money was received. This applies the saved
              payment once; it does not collect it again.
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <p>
              {titleCase(selected.method)} · {moneyWithCode(selected.amount, selected.currency)}
            </p>
          ) : null}
          <Input
            aria-label="Confirmation reference"
            placeholder="Bank or terminal confirmation reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <Input
            aria-label="Confirmation note"
            placeholder="Evidence checked"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={confirm.isPending}
              onClick={() => setSelected(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={confirm.isPending || !reference.trim() || !note.trim()}
              onClick={async () => {
                if (!selected) return;
                try {
                  await confirm.mutateAsync({
                    id: selected.id.slice("payment:".length),
                    reference,
                    note,
                  });
                  setSelected(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Confirmation failed.");
                }
              }}
            >
              Confirm money received
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

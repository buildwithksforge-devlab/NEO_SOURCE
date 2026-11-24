/**
 * Money against a delivery order.
 *
 * The invoice must exist first; this dialog only tells the database how much
 * came in and how, and the database writes the receipt, the balance and the
 * accounting entry.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { methodsFor, PaymentMethodPicker } from "@/components/payments/PaymentMethodPicker";
import { ReceivingAccountSelect } from "@/components/payments/ReceivingAccountSelect";
import { useRecordDeliveryPayment } from "@/lib/delivery-data";

const DELIVERY_METHODS = methodsFor(["cash", "mpesa", "card", "card-terminal", "bank-transfer"]);

export function DeliveryPaymentDialog({
  orderId,
  orderNumber,
  suggestedAmount,
  defaultMethod,
  onOpenChange,
}: {
  orderId: string | null;
  orderNumber: string | null;
  suggestedAmount?: number | undefined;
  defaultMethod?: string | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const record = useRecordDeliveryPayment();
  const [entryType, setEntryType] = useState<"deposit" | "payment">("payment");
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  // Method is how it was paid; this is which hotel account received it.
  const [account, setAccount] = useState<string | null>(null);

  // Preserve the identifier for retries of the same payment details.
  // A new set of details creates a new payment attempt.
  const paymentAttempt = useRef<{
    fingerprint: string;
    id: string;
  } | null>(null);

  useEffect(() => {
    if (!orderId) return;
    setEntryType("payment");
    setMethod(defaultMethod && defaultMethod !== "unspecified" ? defaultMethod : "cash");
    setAmount(suggestedAmount ? String(suggestedAmount) : "");
    setReference("");
    setReason("");
    setAccount(null);
    paymentAttempt.current = null;
  }, [orderId, defaultMethod, suggestedAmount]);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0;

  return (
    <Dialog open={orderId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record money â€” {orderNumber ?? "delivery order"}</DialogTitle>
          <DialogDescription>
            The receipt, the invoice balance and the accounting entry are all written together.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Entry</Label>
            <Select value={entryType} onValueChange={(v) => setEntryType(v as "deposit" | "payment")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deposit">Deposit</SelectItem>
                <SelectItem value="payment">Payment</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <PaymentMethodPicker methods={DELIVERY_METHODS} value={method} onChange={setMethod} />

          <div className="space-y-2">
            <Label htmlFor="delivery-payment-amount">Amount</Label>
            <Input
              id="delivery-payment-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="delivery-payment-reference">Reference</Label>
            <Input
              id="delivery-payment-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="M-Pesa code, slip numberâ€¦"
            />
          </div>

          <ReceivingAccountSelect
            id="delivery-receiving-account"
            value={account}
            onChange={setAccount}
          />

          <div className="space-y-2">
            <Label htmlFor="delivery-payment-reason">Note</Label>
            <Input
              id="delivery-payment-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this entry is being made"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || !orderId || record.isPending}
            onClick={() => {
              if (!orderId || !valid) return;
              const fingerprint = JSON.stringify({
                orderId,
                amount: value,
                method,
                entryType,
                reference: reference.trim(),
                reason: reason.trim(),
                account,
              });

              if (
                !paymentAttempt.current ||
                paymentAttempt.current.fingerprint !== fingerprint
              ) {
                paymentAttempt.current = {
                  fingerprint,
                  id: crypto.randomUUID(),
                };
              }

              record.mutate(
                {
                  orderId,
                  amount: value,
                  method,
                  entryType,
                  reference,
                  reason,
                  destinationAccountId: account,
                  idempotencyKey: paymentAttempt.current.id,
                },
                {
                  onSuccess: () => {
                    paymentAttempt.current = null;
                    onOpenChange(false);
                  },
                },
              );
            }}
          >
            {record.isPending ? "Recordingâ€¦" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


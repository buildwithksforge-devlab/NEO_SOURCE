import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { cashTender } from "@/lib/pos-payment-display";
import { useRequestPosCashPayment, useTillContext } from "@/lib/cash-routing";
import { useRecordPayment } from "@/lib/pos-data";
import {
  useDispatchPaymentIntent,
  useOpenPaymentIntent,
  usePaymentIntentStatus,
} from "@/lib/payment-intents";
import { paymentMethod, usePaymentReadiness } from "@/lib/payment-methods";
import { EXTERNAL_METHODS, money, titleCase } from "@/lib/pos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { methodsFor, PaymentMethodPicker } from "@/components/payments/PaymentMethodPicker";
import { ReceivingAccountSelect } from "@/components/payments/ReceivingAccountSelect";
import { QrPaymentPanel } from "@/components/payments/QrPaymentPanel";
import { MpesaPromptDialog } from "@/components/payments/MpesaPromptDialog";

export function PaymentDialog({
  open,
  onOpenChange,
  orderId,
  branchId,
  balance,
  shiftId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orderId: string;
  branchId: string | null;
  balance: number;
  shiftId: string | null;
}) {
  const record = useRecordPayment();
  // Cash never settles straight from the billing screen: it follows the same
  // request → cashier confirmation path as folio billing, so the notes are
  // always attributed to a named, open till.
  const routeCash = useRequestPosCashPayment();
  const till = useTillContext(branchId);
  const { can } = useAuth();
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState(String(balance.toFixed(2)));
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  const [cardTerminal, setCardTerminal] = useState("");
  const [cardNetwork, setCardNetwork] = useState<"Visa" | "Mastercard" | "Other" | "">("");
  const [cardLast4, setCardLast4] = useState("");
  const [manualConfirm, setManualConfirm] = useState(false);
  const [note, setNote] = useState("");
  // Where the money lands. Separate from the method, which is how it was paid.
  const [account, setAccount] = useState<string | null>(null);
  // One key per settlement attempt: a double-click can never charge twice, but a
  // genuine second payment of the same amount still goes through.
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());
  // A card terminal or QR app answers for itself: the request is opened here and
  // the bill only settles when the processor's own answer arrives.
  const openIntent = useOpenPaymentIntent();
  const dispatchIntent = useDispatchPaymentIntent();
  const [intentId, setIntentId] = useState<string | null>(null);
  const [intentProblem, setIntentProblem] = useState<string | null>(null);
  const providerAttemptLock = useRef(false);
  const [providerAttemptStarted, setProviderAttemptStarted] = useState(false);
  const [qr, setQr] = useState<{ payload: string | null; imageUrl: string | null } | null>(null);
  const intent = usePaymentIntentStatus(intentId);
  const definition = paymentMethod(method);
  const readiness = usePaymentReadiness();
  const providerReady =
    !definition?.provider ||
    (!readiness.isPending &&
      !readiness.isError &&
      readiness.data?.some((row) => row.method === method && row.ready) === true);
  const providerBacked = definition?.kind === "provider";
  const terminalMethod = method === "card-terminal" || method === "qr";
  const external = Boolean(EXTERNAL_METHODS[method]);
  const canManualConfirm = can("pos", "payments", "manual-confirm");
  const amountValue = Number(amount);
  const overpaying = amountValue > balance + 0.005;
  const isCash = method === "cash";
  const cash = cashTender(amountValue, tendered);
  const isManualCard = method === "card";
  const cardLast4Invalid = Boolean(cardLast4) && !/^[0-9]{4}$/.test(cardLast4);
  const selfService = Boolean(till.data?.self_service);
  const blocked =
    providerAttemptStarted ||
    openIntent.isPending ||
    dispatchIntent.isPending ||
    !providerReady ||
    !Number.isFinite(amountValue) ||
    !amountValue ||
    (isCash && Boolean(cash.error)) ||
    amountValue <= 0 ||
    overpaying ||
    (isManualCard &&
      (!cardTerminal.trim() || !cardNetwork || !reference.trim() || cardLast4Invalid)) ||
    (manualConfirm && (!canManualConfirm || !note.trim())) ||
    (isCash && (!branchId || till.isLoading || till.isError)) ||
    record.isPending ||
    routeCash.isPending;

  // Every POS M-Pesa entry point uses the actual STK collection flow. Never
  // create an ordinary recorded payment as a substitute for sending a prompt.
  if (method === "mpesa") {
    return (
      <MpesaPromptDialog
        sourceModule="pos_order"
        sourceRecordId={orderId}
        balance={balance}
        initialAmount={amountValue}
        open={open}
        availabilityBlocked={!providerReady}
        onOpenChange={(next) => {
          if (!next) setMethod("cash");
          onOpenChange(next);
        }}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Take payment</DialogTitle>
          <DialogDescription>Outstanding balance {money(balance)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <PaymentMethodPicker
            methods={methodsFor([
              "cash",
              "card",
              "card-terminal",
              "mpesa",
              "qr",
              "bank-transfer",
              "corporate-credit",
              "voucher",
              "ota-prepaid",
            ])}
            value={method}
            onChange={(next) => {
              if (providerAttemptLock.current) return;
              setMethod(next);
              setIntentId(null);
              setIntentProblem(null);
              setManualConfirm(false);
              if (next !== "card") {
                setCardTerminal("");
                setCardNetwork("");
                setCardLast4("");
              }
            }}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="pay-amount">Amount</Label>
            <Input
              id="pay-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
          </div>
          {method === "cash" ? (
            <div className="grid gap-1.5">
              {!branchId || till.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  Cash routing is unavailable. Check this order’s property and reload its till
                  context before requesting payment.
                </p>
              ) : null}
              <Label htmlFor="pay-tendered">Cash tendered</Label>
              <Input
                id="pay-tendered"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                inputMode="decimal"
              />
              {cash.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {cash.error}
                </p>
              ) : null}
              {!tendered.trim() ? (
                <p className="text-xs text-muted-foreground">Leave blank for exact cash.</p>
              ) : null}
              {cash.change !== null && cash.change > 0 ? (
                <p className="text-xs text-muted-foreground">Change due {money(cash.change!)}</p>
              ) : null}
              <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                {selfService
                  ? `Settles straight into your own open till${till.data?.my_shift_number ? ` (${till.data.my_shift_number})` : ""}, with a receipt and audit entry.`
                  : "You do not hold an open till, so this is routed to an active cashier who confirms the cash physically received before the bill is settled."}
              </p>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="pay-ref">
                {isManualCard
                  ? "Approval / terminal reference"
                  : terminalMethod
                    ? "Your own reference (optional)"
                    : "Reference"}
              </Label>
              <Input
                id="pay-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder={
                  isManualCard
                    ? "e.g. 123456 or terminal slip reference"
                    : terminalMethod
                      ? "The processor supplies its own reference"
                      : "Slip, transfer or voucher number"
                }
              />
              {!providerBacked ? (
                <p className="text-xs text-muted-foreground">
                  Recorded against this bill straight away and marked unverified until someone
                  checks it against the slip or statement.
                </p>
              ) : null}
            </div>
          )}
          {isManualCard ? (
            <div className="grid gap-3 rounded-lg border border-border p-3">
              <div className="grid gap-1.5">
                <Label htmlFor="card-terminal-name">Terminal</Label>
                <Input
                  id="card-terminal-name"
                  value={cardTerminal}
                  onChange={(e) => setCardTerminal(e.target.value)}
                  placeholder="e.g. ABSA POS 1"
                  maxLength={80}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="card-network">Card network</Label>
                <Select
                  value={cardNetwork}
                  onValueChange={(value) =>
                    setCardNetwork(value as "Visa" | "Mastercard" | "Other")
                  }
                >
                  <SelectTrigger id="card-network">
                    <SelectValue placeholder="Select network" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Visa">Visa</SelectItem>
                    <SelectItem value="Mastercard">Mastercard</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="card-last4">Last 4 digits (optional)</Label>
                <Input
                  id="card-last4"
                  value={cardLast4}
                  onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="e.g. 4242"
                  maxLength={4}
                />
                {cardLast4Invalid ? (
                  <p className="text-xs text-destructive">
                    Enter exactly four digits or leave this blank.
                  </p>
                ) : null}
              </div>

              <p className="text-xs text-muted-foreground">
                Record only the terminal result. Never enter a full card number, CVV, PIN or
                magnetic-stripe data.
              </p>
            </div>
          ) : null}
          {external ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
              {EXTERNAL_METHODS[method]} confirms this payment itself. It is held as{" "}
              <strong>awaiting confirmation</strong> until that answer arrives — nothing is marked
              paid on trust.
            </p>
          ) : null}
          {intentProblem ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
              {intentProblem}
            </p>
          ) : null}
          {providerAttemptStarted ? (
            <p role="status" className="text-xs text-muted-foreground">
              This payment attempt is being tracked. Check its status and the order payments before
              starting another collection; closing this dialog does not cancel the attempt.
            </p>
          ) : null}
          {qr ? <QrPaymentPanel payload={qr.payload} imageUrl={qr.imageUrl} /> : null}
          {intentId && intent.data?.ok ? (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
              Request sent to the {titleCase(method.replace("-", " "))}. Current answer:{" "}
              <strong>
                {titleCase(String(intent.data.state ?? "requested").replace("_", " "))}
              </strong>
              . {intent.data.detail ?? ""}
            </p>
          ) : null}
          {external && canManualConfirm ? (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={manualConfirm}
                  disabled={providerAttemptStarted}
                  onChange={(e) => setManualConfirm(e.target.checked)}
                />
                Confirm verified external receipt manually
              </label>
              <p className="text-xs text-muted-foreground">
                Use only after independently verifying that money was received. This does not charge
                the customer; your name and verification note are recorded.
              </p>
              {manualConfirm ? (
                <Textarea
                  aria-label="Verification note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="How was this payment verified?"
                />
              ) : null}
            </div>
          ) : null}
          {isCash ? null : (
            <ReceivingAccountSelect
              id="pos-receiving-account"
              value={account}
              onChange={setAccount}
            />
          )}
          {overpaying ? (
            <p className="text-xs text-destructive">
              The amount cannot exceed the outstanding balance of {money(balance)}.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={blocked}
            onClick={() => {
              if (blocked || providerAttemptLock.current) return;
              if (isCash) {
                routeCash.mutate(
                  {
                    order: orderId,
                    amount: amountValue,
                    ...(reference ? { reference } : {}),
                    idempotencyKey: `pos-cash:${orderId}:${attemptKey}`,
                  },
                  {
                    onSuccess: (result) => {
                      setAttemptKey(crypto.randomUUID());
                      if (result.status !== "no_till") onOpenChange(false);
                    },
                  },
                );
                return;
              }
              const ownReference =
                reference || (terminalMethod ? `REQ-${attemptKey.slice(0, 8).toUpperCase()}` : "");
              if (terminalMethod && !manualConfirm) {
                // Lock synchronously before React renders the mutation state. A
                // lost response can still mean the pending payment was saved.
                providerAttemptLock.current = true;
                setProviderAttemptStarted(true);
              }
              record.mutate(
                {
                  orderId,
                  amount: amountValue,
                  method,
                  ...(account ? { destinationAccountId: account } : {}),
                  ...(Number(tendered) ? { tendered: Number(tendered) } : {}),
                  ...(ownReference ? { externalReference: ownReference } : {}),
                  ...(isManualCard
                    ? {
                        paymentMetadata: {
                          terminal: cardTerminal.trim(),
                          network: cardNetwork as "Visa" | "Mastercard" | "Other",
                          ...(cardLast4 ? { last4: cardLast4 } : {}),
                        },
                      }
                    : {}),
                  shiftId,
                  idempotencyKey: `pos-pay:${orderId}:${attemptKey}`,
                  manualConfirm: manualConfirm && external,
                  ...(manualConfirm && note.trim() ? { note: note.trim() } : {}),
                },
                {
                  onSuccess: (result: unknown) => {
                    setNote("");
                    setManualConfirm(false);
                    const paymentId = (result as { payment_id?: string } | null)?.payment_id;
                    // A terminal or QR request stays on screen: the bill only
                    // settles when the processor answers for itself.
                    if (terminalMethod && !manualConfirm && paymentId) {
                      openIntent.mutate(
                        {
                          module: "pos",
                          sourceRecord: orderId,
                          method,
                          amount: amountValue,
                          branchId,
                          reference: ownReference,
                          linkTable: "pos_payments",
                          linkId: paymentId,
                        },
                        {
                          onSuccess: (opened) => {
                            if (opened.ok && opened.intent_id) {
                              const id = opened.intent_id;
                              setIntentId(id);
                              setIntentProblem(null);
                              dispatchIntent.mutate(
                                { intentId: id },
                                {
                                  onSuccess: (sent) => {
                                    if (sent.qrPayload || sent.qrImageUrl) {
                                      setQr({
                                        payload: sent.qrPayload ?? null,
                                        imageUrl: sent.qrImageUrl ?? null,
                                      });
                                    }
                                    if (!sent.ok) {
                                      setIntentProblem(
                                        sent.detail ??
                                          "The request could not be sent to the processor, so this payment stays awaiting confirmation.",
                                      );
                                    }
                                  },
                                  onError: (e: Error) => setIntentProblem(e.message),
                                },
                              );
                            } else {
                              setIntentProblem(
                                opened.detail ??
                                  "No processor is connected for this method, so the payment stays awaiting confirmation.",
                              );
                            }
                          },
                          onError: (e: Error) => setIntentProblem(e.message),
                        },
                      );
                      return;
                    }
                    if (terminalMethod && !manualConfirm) {
                      setIntentProblem(
                        "The payment response has no tracking ID. Check the order payments before starting another collection.",
                      );
                      return;
                    }
                    setAttemptKey(crypto.randomUUID());
                    onOpenChange(false);
                  },
                  onError: (error: Error) => {
                    if (terminalMethod && !manualConfirm) {
                      setIntentProblem(
                        `${error.message} Check the order payments before starting another collection; the request may have been recorded.`,
                      );
                    }
                  },
                },
              );
            }}
          >
            {isCash
              ? selfService
                ? "Confirm cash received"
                : "Send to cashier"
              : manualConfirm && external
                ? "Record & confirm"
                : terminalMethod
                  ? "Send to terminal"
                  : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

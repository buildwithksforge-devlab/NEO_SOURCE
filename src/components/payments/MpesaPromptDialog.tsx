/**
 * "Charge to M-Pesa" — sends an STK prompt for a restaurant bill or guest folio
 * and then tracks the provider outcome. Nothing is marked paid here: the pending
 * payment is confirmed only when Safaricom's own result arrives, either through
 * the callback or through an explicit status check.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { chargeWithMpesa, reconcileMpesaTransaction } from "@/lib/mpesa.functions";
import { useMpesaCollectionStatus } from "@/lib/payment-methods";

type Props = {
  sourceModule: "pos_order" | "folio";
  sourceRecordId: string;
  balance: number;
  defaultPhone?: string | null;
  description?: string;
  onSettled?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialAmount?: number;
  availabilityBlocked?: boolean;
  paymentId?: string;
  recoveryOnly?: boolean;
  triggerLabel?: string;
};

const TERMINAL = new Set(["success", "failed", "cancelled", "timeout", "unknown"]);

export function MpesaPromptDialog({
  sourceModule,
  sourceRecordId,
  balance,
  defaultPhone,
  description,
  onSettled,
  open: controlledOpen,
  onOpenChange,
  initialAmount,
  availabilityBlocked = false,
  paymentId,
  recoveryOnly = false,
  triggerLabel = "M-Pesa prompt",
}: Props) {
  const charge = useServerFn(chargeWithMpesa);
  const reconcile = useServerFn(reconcileMpesaTransaction);
  const queryClient = useQueryClient();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [phone, setPhone] = useState(defaultPhone ?? "");
  const [amount, setAmount] = useState(
    (initialAmount ?? balance) > 0 ? (initialAmount ?? balance).toFixed(2) : "",
  );
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lookupPending, setLookupPending] = useState(true);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const sendLock = useRef(false);

  useEffect(() => {
    if (!open) {
      setTransactionId(null);
      setMessage(null);
      setAmount(balance > 0 ? balance.toFixed(2) : "");
      setLookupPending(true);
    }
  }, [open, balance]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLookupPending(true); setLookupError(null); setTransactionId(null);
    void (async () => {
      try {
        let query = supabase.from("mpesa_transactions").select("id, amount")
          .eq("source_record_id", sourceRecordId)
          .in("source_module", sourceModule === "folio" ? ["folio", "guest_folio"] : ["pos_order"]);
        query = paymentId ? query.eq("payment_id", paymentId)
          : query.in("status", ["initiated", "pending", "unknown"]).is("applied_at", null);
        const result = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (result.error) throw result.error;
        if (!cancelled && result.data) {
          setTransactionId(result.data.id); setAmount(Number(result.data.amount).toFixed(2));
          setMessage("Existing M-Pesa attempt found. Check its Safaricom status; no new prompt was sent.");
        }
      } catch {
        if (!cancelled) setLookupError("The existing payment attempt could not be checked. Close and reopen this dialog; do not send another prompt.");
      } finally { if (!cancelled) setLookupPending(false); }
    })();
    return () => { cancelled = true; };
  }, [open, sourceModule, sourceRecordId, paymentId]);

  const status = useQuery({
    queryKey: ["mpesa-transaction", transactionId],
    enabled: Boolean(transactionId),
    refetchInterval: (query) => {
      const row = query.state.data as { status?: string } | undefined;
      return row && TERMINAL.has(row.status ?? "") ? false : 4000;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mpesa_transactions")
        .select("id, status, result_desc, mpesa_receipt_number, amount, failure_detail")
        .eq("id", transactionId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const currentStatus = (status.data?.status as string | undefined) ?? null;

  useEffect(() => {
    if (currentStatus && TERMINAL.has(currentStatus)) {
      if (currentStatus === "success") {
        toast.success(
          `M-Pesa payment received${status.data?.mpesa_receipt_number ? ` — ${status.data.mpesa_receipt_number}` : ""}`,
        );
      } else if (currentStatus === "unknown") {
        toast.warning(
          "Safaricom's response is unclear. Do not send another prompt until the existing attempt is checked.",
        );
      } else {
        toast.error(
          status.data?.failure_detail ??
            status.data?.result_desc ??
            "The customer did not complete the payment.",
        );
      }
      void queryClient.invalidateQueries();
      onSettled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStatus]);

  const send = useMutation({
    mutationFn: async () =>
      charge({
        data: {
          sourceModule,
          sourceRecordId,
          msisdn: phone,
          amount: Number(amount),
          description: description ?? null,
        },
      }),
    onSuccess: (result) => {
      setMessage(result.detail);
      if (result.ok && result.transactionId) {
        setTransactionId(result.transactionId);
        if (result.status === "unknown") toast.warning(result.detail);
        else if (result.reused) toast.info(result.detail);
        else
          toast.success("Safaricom accepted the prompt request. Awaiting customer confirmation.");
      } else {
        toast.error(result.detail);
      }
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      sendLock.current = false;
    },
  });

  const check = useMutation({
    mutationFn: async (id: string) => reconcile({ data: { transactionId: id } }),
    onSuccess: (result) => {
      setMessage(result.detail || `Status: ${result.status}`);
      void status.refetch();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const amountValue = Number(amount);
  const setup = useMpesaCollectionStatus();
  const setupReady =
    !availabilityBlocked && !setup.isPending && !setup.isError && setup.data?.ready === true;
  const blocked =
    recoveryOnly || lookupPending || Boolean(lookupError) ||
    !setupReady ||
    !phone.trim() ||
    !Number.isSafeInteger(amountValue) ||
    !(amountValue > 0) ||
    amountValue > balance + 0.005 ||
    Boolean(transactionId) ||
    send.isPending;

  // The workspace configuration is the single source of truth: when M-Pesa is
  // not switched on, the action says so up front instead of failing on send,
  // and points at the one place it is set up.
  const setupMessage = setup.isPending
    ? "Checking M-Pesa availability…"
    : setup.isError
      ? "M-Pesa availability could not be verified. Retry before sending a prompt."
      : (setup.data?.reason ?? "M-Pesa is not available for this workspace.");
  if (!setupReady && controlledOpen === undefined) {
    return (
      <div className="inline-flex flex-col gap-1">
        <Button size="sm" variant="outline" disabled title={setupMessage}>
          <Smartphone className="mr-2 size-4" />
          {setup.isPending ? "Checking M-Pesa…" : "M-Pesa unavailable"}
        </Button>
        <Link
          to="/admin/payments-mpesa"
          className="text-[11px] text-muted-foreground underline underline-offset-2"
        >
          {setupMessage}
        </Link>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined ? (
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            <Smartphone className="mr-2 size-4" /> {triggerLabel}
          </Button>
        </DialogTrigger>
      ) : null}

      <DialogContent>
        <DialogHeader>
          <DialogTitle>{recoveryOnly ? "M-Pesa payment status" : "Charge to M-Pesa"}</DialogTitle>
          <DialogDescription>
            {recoveryOnly ? "Checks the existing collection with Safaricom. This does not send a prompt or collect money."
              : "Sends an STK prompt to the customer. The payment stays pending until Safaricom confirms it."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {lookupPending ? <p role="status" className="text-sm text-muted-foreground">Checking for an existing M-Pesa attempt…</p> : null}
          {lookupError ? <p role="alert" className="text-sm text-destructive">{lookupError}</p> : null}
          {recoveryOnly && !lookupPending && !lookupError && !transactionId ? <p role="status" className="text-sm">No STK collection is linked to this payment. No prompt was sent.</p> : null}
          {!setupReady ? (
            <p role="alert" className="text-sm text-destructive">
              {setupMessage}
            </p>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="mpesa-phone">Customer phone</Label>
            <Input
              id="mpesa-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="07XX XXX XXX"
              inputMode="tel"
              disabled={recoveryOnly || lookupPending || Boolean(transactionId) || send.isPending}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mpesa-amount">Amount</Label>
            <Input
              id="mpesa-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              disabled={recoveryOnly || lookupPending || Boolean(transactionId) || send.isPending}
            />
            <p className="text-xs text-muted-foreground">
              Outstanding balance {balance.toFixed(2)}
              {" · M-Pesa requires a whole KES amount."}
            </p>
          </div>
          {message ? (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs">{message}</p>
          ) : null}
          {transactionId ? (
            <div className="rounded-lg border border-border p-3 text-xs">
              <p className="font-medium">
                Provider status: {currentStatus ?? "waiting"}
                {status.isFetching ? <Loader2 className="ml-2 inline size-3 animate-spin" /> : null}
              </p>
              {status.data?.mpesa_receipt_number ? (
                <p>Receipt {status.data.mpesa_receipt_number}</p>
              ) : null}
              {status.data?.result_desc ? (
                <p className="text-muted-foreground">{status.data.result_desc}</p>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {transactionId ? (
            <>
              {currentStatus === "unknown" ? (
                <p className="self-center text-xs text-muted-foreground">
                  Check Recent collections before sending another prompt.
                </p>
              ) : null}
                <Button variant="outline" disabled={check.isPending || lookupPending} onClick={() => { if (transactionId) check.mutate(transactionId); }}>
                  {check.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  Check Safaricom status
                </Button>
              <Button onClick={() => setOpen(false)}>Close</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
              {!recoveryOnly ? <Button
                disabled={blocked}
                onClick={() => {
                  if (blocked || sendLock.current) return;
                  sendLock.current = true;
                  send.mutate();
                }}
              >
                {send.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Send prompt
              </Button> : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

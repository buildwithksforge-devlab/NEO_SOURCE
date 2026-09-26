/**
 * "Charge to M-Pesa" — sends an STK prompt for a restaurant bill or guest folio
 * and then tracks the provider outcome. Nothing is marked paid here: the pending
 * payment is confirmed only when Safaricom's own result arrives, either through
 * the callback or through an explicit status check.
 */
import { useEffect, useState } from "react";
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
};

const TERMINAL = new Set(["success", "failed", "cancelled", "timeout"]);

export function MpesaPromptDialog({
  sourceModule,
  sourceRecordId,
  balance,
  defaultPhone,
  description,
  onSettled,
}: Props) {
  const charge = useServerFn(chargeWithMpesa);
  const reconcile = useServerFn(reconcileMpesaTransaction);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(defaultPhone ?? "");
  const [amount, setAmount] = useState(balance > 0 ? balance.toFixed(2) : "");
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTransactionId(null);
      setMessage(null);
      setAmount(balance > 0 ? balance.toFixed(2) : "");
    }
  }, [open, balance]);

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
        toast.success(`M-Pesa payment received${status.data?.mpesa_receipt_number ? ` — ${status.data.mpesa_receipt_number}` : ""}`);
      } else {
        toast.error(status.data?.failure_detail ?? status.data?.result_desc ?? "The customer did not complete the payment.");
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
        toast.success("Prompt sent to the customer's phone");
      } else {
        toast.error(result.detail);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const check = useMutation({
    mutationFn: async () => reconcile({ data: { transactionId: transactionId! } }),
    onSuccess: (result) => {
      setMessage(result.detail || `Status: ${result.status}`);
      void status.refetch();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const amountValue = Number(amount);
  const blocked = !phone.trim() || !(amountValue > 0) || amountValue > balance + 0.005 || send.isPending;

  // The workspace configuration is the single source of truth: when M-Pesa is
  // not switched on, the action says so up front instead of failing on send,
  // and points at the one place it is set up.
  const setup = useMpesaCollectionStatus();
  if (setup.data && !setup.data.ready) {
    return (
      <div className="inline-flex flex-col gap-1">
        <Button size="sm" variant="outline" disabled title={setup.data.reason ?? undefined}>
          <Smartphone className="mr-2 size-4" />
          {setup.data.configured ? "M-Pesa switched off" : "M-Pesa not set up"}
        </Button>
        <Link to="/admin/payments-mpesa" className="text-[11px] text-muted-foreground underline underline-offset-2">
          {setup.data.reason ?? "Open M-Pesa settings"}
        </Link>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Smartphone className="mr-2 size-4" /> M-Pesa prompt
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Charge to M-Pesa</DialogTitle>
          <DialogDescription>
            Sends an STK prompt to the customer. The payment stays pending until Safaricom confirms it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="mpesa-phone">Customer phone</Label>
            <Input
              id="mpesa-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="07XX XXX XXX"
              inputMode="tel"
              disabled={Boolean(transactionId)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mpesa-amount">Amount</Label>
            <Input
              id="mpesa-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              disabled={Boolean(transactionId)}
            />
            <p className="text-xs text-muted-foreground">Outstanding balance {balance.toFixed(2)}</p>
          </div>
          {message ? <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs">{message}</p> : null}
          {transactionId ? (
            <div className="rounded-lg border border-border p-3 text-xs">
              <p className="font-medium">
                Provider status: {currentStatus ?? "waiting"}
                {status.isFetching ? <Loader2 className="ml-2 inline size-3 animate-spin" /> : null}
              </p>
              {status.data?.mpesa_receipt_number ? <p>Receipt {status.data.mpesa_receipt_number}</p> : null}
              {status.data?.result_desc ? <p className="text-muted-foreground">{status.data.result_desc}</p> : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {transactionId ? (
            <>
              <Button variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
                {check.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Check status
              </Button>
              <Button onClick={() => setOpen(false)}>Close</Button>
            </>
          ) : (
            <Button disabled={blocked} onClick={() => send.mutate()}>
              {send.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Send prompt
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

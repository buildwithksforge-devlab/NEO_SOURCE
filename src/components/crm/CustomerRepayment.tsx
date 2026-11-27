import { useEffect, useRef, useState } from "react";
import {
  saveRepaymentRecovery,
  readRepaymentRecovery,
  clearRepaymentRecovery,
} from "@/lib/customer-repayment-recovery";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { invalidatePaymentViews } from "@/lib/payment-view-refresh";
import {
  invoiceRepaymentEligible,
  validateCustomerRepayment,
  assertCustomerRepaymentResult,
  type CustomerInvoiceRow,
  type CustomerRepaymentInput,
} from "@/lib/customer-repayment";

type Props = {
  customerId: string;
  invoices: CustomerInvoiceRow[];
  onRecorded: () => Promise<unknown>;
};

const initial = {
  invoiceId: "",
  amount: "",
  method: "cash",
  reference: "",
  notes: "",
  accountId: "",
};

export function CustomerRepayment({
  customerId,
  invoices,
  onRecorded,
}: Props) {
  const { can, user, organizationId } = useAuth();
  const qc = useQueryClient();

  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [unresolved, setUnresolved] = useState(false);

  const attempt = useRef<string | null>(null);
  const submitting = useRef(false);

  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");

  const recoveryScope =
    user?.id && organizationId && customerId
      ? {
          userId: user.id,
          organizationId,
          customerId,
        }
      : null;

  useEffect(() => {
    setRecoveryReady(false);
    setRecoveryError("");
    setForm(initial);
    setReceipt("");
    setUnresolved(false);
    attempt.current = null;

    if (!user?.id || !organizationId || !customerId) {
      return;
    }

    try {
      const saved = readRepaymentRecovery(
        window.localStorage,
        {
          userId: user.id,
          organizationId,
          customerId,
        }
      );

      if (saved) {
        setForm({
          invoiceId: saved.invoiceId,
          amount: saved.amount,
          method: saved.method,
          reference: saved.reference,
          notes: saved.notes,
          accountId: saved.accountId,
        });

        attempt.current = saved.intentKey;
        setUnresolved(true);
      }

      setRecoveryReady(true);
    } catch (error) {
      setRecoveryError(
        error instanceof Error
          ? error.message
          : "Repayment recovery is unavailable."
      );
    }
  }, [user?.id, organizationId, customerId]);

  const allowed =
    can?.("finance", "ar.allocate_receipt") === true;

  const eligible = invoices.filter(invoiceRepaymentEligible);

  const selected = eligible.find(
    (invoice) => String(invoice["id"]) === form.invoiceId
  );

  function change(
    key: keyof typeof initial,
    value: string
  ) {
    if (busy || unresolved) return;

    setForm((current) => ({
      ...current,
      [key]: value,
    }));

    attempt.current = null;
    setReceipt("");
  }

  async function submit() {
    if (
      !allowed ||
      submitting.current ||
      !recoveryReady ||
      recoveryError ||
      !recoveryScope
    ) return;

    const invoice = invoices.find(
      (row) => String(row["id"]) === form.invoiceId
    );

    if (!invoice) {
      toast.error("Select the outstanding invoice.");
      return;
    }

    const input: CustomerRepaymentInput = {
      ...form,
      intentKey:
        attempt.current ??
        `customer-repayment:${crypto.randomUUID()}`,
    };

    let amount: number;

    try {
      // A retry must retain the original payment identity.
      // The server checks whether that payment already exists.
      amount = unresolved
        ? Number(input.amount)
        : validateCustomerRepayment(input, invoice);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Invalid repayment."
      );
      return;
    }

    try {
      saveRepaymentRecovery(
        window.localStorage,
        recoveryScope,
        input
      );
    } catch {
      toast.error(
        "Transaction recovery could not be secured. No payment was submitted."
      );
      return;
    }

    attempt.current = input.intentKey;
    submitting.current = true;
    setBusy(true);

    try {
      const db = supabase as any;

      const { data, error } = await db.rpc(
        "neo_ar_record_customer_payment",
        {
          _invoice: input.invoiceId,
          _amount: amount,
          _method: input.method,
          _reference: input.reference.trim() || null,
          _paid_on: null,
          _notes: input.notes.trim() || null,
          _campaign: null,
          _intent_key: input.intentKey,
          _account: input.accountId,
        }
      );

      if (error) throw new Error(error.message);

      const result = assertCustomerRepaymentResult(data);

      // Only clear recovery after the backend confirms
      // the persisted receipt and journal.
      clearRepaymentRecovery(
        window.localStorage,
        recoveryScope
      );

      setReceipt(result.receiptNumber);
      setUnresolved(false);
      setForm(initial);
      attempt.current = null;

      toast.success(
        result.duplicatePrevented
          ? `Existing receipt confirmed: ${result.receiptNumber}`
          : `Repayment recorded: ${result.receiptNumber}`
      );

      // Refresh errors must not make a completed payment
      // appear to have failed.
      await Promise.allSettled([
        onRecorded(),
        Promise.resolve(invalidatePaymentViews(qc)),
        qc.invalidateQueries({
          queryKey: ["cashier-personal-collections"],
        }),
      ]);
    } catch (error) {
      setUnresolved(true);

      toast.error(
        error instanceof Error
          ? error.message
          : "Receipt confirmation failed."
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (!allowed) return null;

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold">
          Receive customer debt repayment
        </h2>

        <p className="text-sm text-muted-foreground">
          Apply received money against an existing invoice.
          The canonical receivables engine creates the receipt
          and corresponding financial journal.
        </p>
      </div>

      {recoveryError && (
        <p role="alert" className="text-sm text-destructive">
          {recoveryError}
        </p>
      )}

      {receipt && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          Confirmed receipt: {receipt}
        </p>
      )}

      {unresolved && (
        <p role="alert" className="rounded-lg border p-3 text-sm text-destructive">
          This transaction has not been confirmed.
          Retry the same repayment before recording another one.
          Its transaction identity has been retained.
        </p>
      )}

      {eligible.length === 0 && !unresolved ? (
        <p className="text-sm text-muted-foreground">
          No eligible outstanding invoices were returned.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              Outstanding invoice
              <select
                disabled={busy || unresolved}
                value={form.invoiceId}
                onChange={(e) => change("invoiceId", e.target.value)}
                className="rounded-md border bg-background p-2"
              >
                <option value="">Select invoice</option>

                {eligible.map((invoice) => (
                  <option
                    key={String(invoice["id"])}
                    value={String(invoice["id"])}
                  >
                    {String(invoice["invoice_number"])}
                    {" — "}
                    {String(invoice["currency"] ?? "")}
                    {" "}
                    {Number(invoice["balance"]).toFixed(2)}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1 text-sm">
              Repayment amount
              <input
                inputMode="decimal"
                disabled={busy || unresolved}
                value={form.amount}
                onChange={(e) => change("amount", e.target.value)}
                className="rounded-md border bg-background p-2"
              />
            </label>

            {selected && (
              <button
                type="button"
                disabled={busy || unresolved}
                onClick={() =>
                  change(
                    "amount",
                    Number(selected["balance"]).toFixed(2)
                  )
                }
                className="rounded-md border px-3 py-2 text-sm"
              >
                Set full outstanding balance
              </button>
            )}

            <label className="grid gap-1 text-sm">
              Receiving financial account ID
              <input
                disabled={busy || unresolved}
                value={form.accountId}
                onChange={(e) => change("accountId", e.target.value)}
                placeholder="Authorised account UUID"
                className="rounded-md border bg-background p-2"
              />
            </label>

            <label className="grid gap-1 text-sm">
              Payment method
              <select
                disabled={busy || unresolved}
                value={form.method}
                onChange={(e) => change("method", e.target.value)}
                className="rounded-md border bg-background p-2"
              >
                <option value="cash">Cash</option>
                <option value="mpesa">M-Pesa</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank transfer</option>
              </select>
            </label>

            <label className="grid gap-1 text-sm">
              Payment reference
              <input
                disabled={busy || unresolved}
                value={form.reference}
                onChange={(e) => change("reference", e.target.value)}
                className="rounded-md border bg-background p-2"
              />
            </label>

            <label className="grid gap-1 text-sm sm:col-span-2">
              Notes
              <textarea
                disabled={busy || unresolved}
                value={form.notes}
                onChange={(e) => change("notes", e.target.value)}
                className="rounded-md border bg-background p-2"
              />
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            Record only money already received and verified.
            This operation does not initiate a bank, card or
            M-Pesa payment.
          </p>

          <button
            type="button"
            disabled={
              busy ||
              !form.invoiceId ||
              !recoveryReady ||
              Boolean(recoveryError)
            }
            onClick={() => void submit()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {busy
              ? "Confirming repayment..."
              : unresolved
                ? "Retry existing repayment"
                : "Record received repayment"}
          </button>
        </>
      )}
    </section>
  );
}
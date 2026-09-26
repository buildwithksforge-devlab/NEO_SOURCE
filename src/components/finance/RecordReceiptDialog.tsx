/**
 * Recording money received against a customer invoice.
 *
 * The screen only collects what a cashier can actually know: how much came in,
 * how it came in, the payer's reference and the date it landed. Everything that
 * follows — the receipt number, the invoice balance, the journal that moves the
 * money into cash or bank and out of what the customer owes — is decided by the
 * database, so the cashbook and the reconciliation panel show the same receipt
 * without a second entry anywhere.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormDialog, RecordForm, type FieldSpec } from "@/components/finance/FinanceShared";
import { useRecordCustomerReceipt } from "@/lib/finance-data";
import { useReceivingAccounts } from "@/lib/financial-accounts";
import { money, num } from "@/lib/finance";
import { useAuth } from "@/lib/auth";
import type { Row } from "@/lib/finance";

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "bank-transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "mpesa", label: "M-Pesa" },
  { value: "card", label: "Card" },
];

export function RecordReceiptDialog({
  invoice,
  campaigns,
}: {
  invoice: Row;
  /** Optional: attribute the money to a campaign the operator names explicitly. */
  campaigns?: { id: string; name: string }[];
}) {
  const { can, isAdmin } = useAuth();
  const record = useRecordCustomerReceipt();
  const accounts = useReceivingAccounts();
  const [open, setOpen] = useState(false);

  const allowed = isAdmin || can("finance", "ar", "allocate_receipt");
  if (!allowed) return null;

  const currency = String(invoice["currency"] ?? "KES");
  const balance = Number(num(invoice["balance"]).toFixed(2));
  const invoiceNumber = String(invoice["invoice_number"] ?? "");
  if (balance <= 0) return null;

  const fields: FieldSpec[] = [
    { name: "amount", label: `Amount received (${currency})`, type: "number", required: true },
    { name: "method", label: "How it was received", type: "select", required: true, options: METHODS },
    // How it was paid and where it landed are two different facts.
    ...((accounts.data ?? []).length > 0
      ? ([
          {
            name: "destination_account_id",
            label: "Money received into",
            type: "select",
            options: (accounts.data ?? []).map((a) => ({
              value: a.id,
              label: `${a.name}${a.currency ? ` · ${a.currency}` : ""}`,
            })),
          },
        ] as FieldSpec[])
      : []),
    { name: "paid_on", label: "Date received", type: "date" },
    { name: "reference", label: "Payer reference", type: "text", placeholder: "Transfer, cheque or M-Pesa reference" },
    ...(campaigns && campaigns.length > 0
      ? ([
          {
            name: "campaign_id",
            label: "Campaign that won this business (optional)",
            type: "select",
            options: campaigns.map((c) => ({ value: c.id, label: c.name })),
          },
        ] as FieldSpec[])
      : []),
    { name: "notes", label: "Note", type: "textarea", span: true },
  ];

  return (
    <FormDialog
      title="Record receipt"
      description={`Invoice ${invoiceNumber} — ${money(balance, currency)} outstanding. The money posts to the books as soon as it is recorded.`}
      trigger={
        <Button size="sm" variant="outline">
          Record receipt
        </Button>
      }
      onOpenChange={setOpen}
    >
      {(close) => (
        <RecordForm
          // Remount the fields each time the dialog opens so a previous entry
          // is never carried into the next receipt.
          key={open ? "open" : "closed"}
          fields={fields}
          initial={{ amount: balance, method: "cash" }}
          submitLabel="Record receipt"
          busy={record.isPending}
          validate={(v) => {
            const amount = Number(v["amount"] ?? 0);
            if (!Number.isFinite(amount) || amount <= 0) return "Enter how much money was received.";
            if (amount - balance > 0.009)
              return `That is more than the ${money(balance, currency)} still outstanding on this invoice.`;
            if (!v["method"]) return "Choose how the money was received.";
            return null;
          }}
          onSubmit={(v) => {
            record.mutate(
              {
                invoiceId: String(invoice["id"]),
                amount: Number(v["amount"]),
                method: String(v["method"] ?? "cash"),
                reference: (String(v["reference"] ?? "").trim() || undefined) as string | undefined,
                paidOn: (String(v["paid_on"] ?? "").trim() || undefined) as string | undefined,
                notes: (String(v["notes"] ?? "").trim() || undefined) as string | undefined,
                campaignId: (String(v["campaign_id"] ?? "").trim() || undefined) as string | undefined,
                destinationAccountId:
                  String(v["destination_account_id"] ?? "").trim() || null,
              },
              { onSuccess: () => close() },
            );
          }}
        />
      )}
    </FormDialog>
  );
}

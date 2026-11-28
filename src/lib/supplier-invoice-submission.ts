export type SupplierInvoiceDraft = {
  orderNumber: string;
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
  deliveryReference: string;
  notes: string;
};

export function validateSupplierInvoiceSubmission(
  draft: SupplierInvoiceDraft
) {
  const orderNumber = draft.orderNumber.trim();
  const invoiceNumber = draft.invoiceNumber.trim();
  const invoiceDate = draft.invoiceDate.trim();
  const amountText = draft.amount.trim();
  const deliveryReference = draft.deliveryReference.trim();
  const notes = draft.notes.trim();

  if (!orderNumber) {
    throw new Error("Select a purchase order.");
  }

  if (
    !invoiceNumber ||
    invoiceNumber.length > 120
  ) {
    throw new Error("Enter a valid invoice number.");
  }

  const timestamp = Date.parse(
    `${invoiceDate}T00:00:00Z`
  );

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0,10) !== invoiceDate
  ) {
    throw new Error("Enter a valid invoice date.");
  }

  if (!/^\d+(\.\d{1,2})?$/.test(amountText)) {
    throw new Error("Enter a valid invoice amount.");
  }

  const amount = Number(amountText);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > Number.MAX_SAFE_INTEGER / 100
  ) {
    throw new Error("Invoice amount is invalid.");
  }

  if (
    deliveryReference.length > 200 ||
    notes.length > 4000
  ) {
    throw new Error("Invoice reference or notes are too long.");
  }

  return {
    orderNumber,
    invoiceNumber,
    invoiceDate,
    amount,
    deliveryReference: deliveryReference || null,
    notes: notes || null,
  };
}

export function assertSupplierInvoiceSubmission(
  value: unknown
): string {
  const result = value as Record<string,unknown> | null;

  if (
    !result ||
    result["ok"] !== true ||
    typeof result["submission_id"] !== "string" ||
    !result["submission_id"]
  ) {
    throw new Error("Invoice submission could not be confirmed.");
  }

  return result["submission_id"];
}
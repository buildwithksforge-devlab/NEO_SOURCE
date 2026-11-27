export type CustomerInvoiceRow = Record<string, unknown>;

export type CustomerRepaymentInput = {
  invoiceId: string;
  amount: string;
  method: string;
  reference: string;
  notes: string;
  accountId: string;
  intentKey: string;
};

const eligibleStatuses = new Set([
  "issued",
  "partially_paid",
  "overdue",
]);

export function invoiceRepaymentEligible(
  invoice: CustomerInvoiceRow
): boolean {
  const balance = Number(invoice["balance"]);

  return Boolean(
    invoice["id"] &&
    invoice["balance"] !== null &&
    invoice["balance"] !== undefined &&
    eligibleStatuses.has(String(invoice["status"])) &&
    Number.isFinite(balance) &&
    balance > 0
  );
}

export function validateCustomerRepayment(
  input: CustomerRepaymentInput,
  invoice: CustomerInvoiceRow
): number {
  if (!invoiceRepaymentEligible(invoice)) {
    throw new Error("This invoice cannot accept a repayment.");
  }

  if (String(invoice["id"]) !== input.invoiceId) {
    throw new Error("The selected invoice has changed.");
  }

  if (!/^\d+(\.\d{1,2})?$/.test(input.amount.trim())) {
    throw new Error(
      "Enter a positive amount with at most two decimal places."
    );
  }

  const amount = Number(input.amount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error("Enter a valid positive amount.");
  }

  if (amount > Number(invoice["balance"])) {
    throw new Error(
      "Repayment exceeds the outstanding invoice balance."
    );
  }

  if (!input.intentKey.trim()) {
    throw new Error("A transaction identity is required.");
  }

  if (!input.accountId.trim()) {
    throw new Error("Select the receiving financial account.");
  }

  if (!["cash", "mpesa", "card", "bank_transfer"].includes(input.method)) {
    throw new Error("Unsupported collection method.");
  }

  if (
    input.method !== "cash" &&
    !input.reference.trim()
  ) {
    throw new Error(
      "A verified external payment reference is required."
    );
  }

  return amount;
}

export function assertCustomerRepaymentResult(
  value: unknown
) {
  const result = value as Record<string, unknown> | null;

  if (
    !result ||
    result["ok"] !== true ||
    typeof result["payment_id"] !== "string" ||
    !result["payment_id"] ||
    typeof result["journal_id"] !== "string" ||
    !result["journal_id"] ||
    typeof result["receipt_number"] !== "string" ||
    !result["receipt_number"]
  ) {
    throw new Error(
      "The receipt and its accounting journal could not be confirmed. Retry the same transaction identity before recording another payment."
    );
  }

  return {
    paymentId: result["payment_id"],
    journalId: result["journal_id"],
    receiptNumber: result["receipt_number"],
    duplicatePrevented:
      result["duplicate_prevented"] === true,
  };
}
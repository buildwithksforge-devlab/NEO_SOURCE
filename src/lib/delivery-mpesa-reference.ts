/**
 * Customer-submitted M-PESA reference.
 *
 * IMPORTANT:
 * A receipt code is a claim of payment, not proof that the
 * merchant received the money.
 */

export type DeliveryMpesaClaim = {
  orderId: string;
  receiptCode: string;
  submittedAt: string;
  status: "awaiting-verification";
};

export function normaliseMpesaReceiptCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "").trim();
}

export function validateMpesaReceiptCode(value: string): string {
  const code = normaliseMpesaReceiptCode(value);

  if (!/^[A-Z0-9]{10,12}$/.test(code)) {
    throw new Error("Enter a valid M-PESA transaction code.");
  }

  return code;
}

export function createDeliveryMpesaClaim(
  orderId: string,
  receiptCode: string
): DeliveryMpesaClaim {
  if (!orderId.trim()) {
    throw new Error("A delivery order is required.");
  }

  return {
    orderId: orderId.trim(),
    receiptCode: validateMpesaReceiptCode(receiptCode),
    submittedAt: new Date().toISOString(),
    status: "awaiting-verification",
  };
}

/**
 * Customer-submitted M-PESA reference.
 *
 * IMPORTANT:
 * A receipt code is a claim of payment, not proof that the
 * merchant received the money.
 */

import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

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

export async function submitDeliveryMpesaReference(orderId: string, value: string) {
  const code = validateMpesaReceiptCode(value);
  const { data, error } = await guardedRpc<{
    ok?: boolean;
    claim_id?: string;
    status?: string;
    detail?: string;
    reason?: string;
  }>(supabase, "neo_delivery_mpesa_till_claim_submit", { _order: orderId, _receipt: code });

  if (error) throw new Error(error.message);
  if (data?.ok === true && data.claim_id) {
    if (data.status === "submitted" || data.status === "merchant_verified") return data.status;
    if (data.status === "rejected") throw new Error("Finance rejected this reference. Check the code and contact the property if it is correct.");
  }
  if (data?.reason === "receipt_already_submitted") {
    throw new Error("That reference was already submitted for another order.");
  }
  if (data?.reason === "order_closed") throw new Error("This order no longer accepts payment references.");
  throw new Error(data?.detail ?? "We could not confirm that your reference was saved. Check the code and try again.");
}

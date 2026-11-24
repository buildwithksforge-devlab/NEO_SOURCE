import { requireSavedRecord } from "./durable-command-result";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export type GuestOrderResult = {
  delivery_order_id: string;
  pos_order_id: string;
  order_number: string;
  charged_to_room?: boolean;
  pin?: string | null;
  duplicate_suppressed?: boolean;
};

/** Success needs the saved order pair, and a saved room charge when requested. */
export function requireGuestOrderResult(value: unknown, roomCharge?: boolean): GuestOrderResult {
  const message = "The server did not confirm the saved order. Review your existing orders before retrying.";
  const saved = requireSavedRecord(value, ["delivery_order_id", "pos_order_id", "order_number"], message);
  if (!UUID.test(String(saved["delivery_order_id"])) || !UUID.test(String(saved["pos_order_id"]))) {
    throw new Error(message);
  }
  if (roomCharge !== undefined && saved["charged_to_room"] !== roomCharge) {
    throw new Error("The server did not confirm the selected settlement option. Review your existing order before retrying.");
  }
  // The existing idempotent replay deliberately does not return the old folio
  // line ID. A first room-charge result must provide that saved evidence.
  if (roomCharge && saved["duplicate_suppressed"] !== true
    && !UUID.test(String(saved["folio_line_id"] ?? ""))) {
    throw new Error("The order's saved room-bill charge was not confirmed. Review the existing order before retrying.");
  }
  return saved as GuestOrderResult;
}

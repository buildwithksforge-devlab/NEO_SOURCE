import { supabase } from "@/integrations/supabase/client";

const db = supabase as any;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function complimentaryExecutionPayload(
  orderId:string,
  itemId:string,
  approvalId:string
) {

  if (
    !UUID.test(orderId) ||
    !UUID.test(itemId) ||
    !UUID.test(approvalId)
  ) {
    throw new Error(
      "Valid order, item and approval identities are required."
    );
  }

  return {
    _order:orderId,
    _item:itemId,
    _approval:approvalId,
  };
}

export async function executeApprovedComplimentary(
  orderId:string,
  itemId:string,
  approvalId:string
) {

  const payload = complimentaryExecutionPayload(
    orderId,itemId,approvalId
  );

  const {data,error} = await db.rpc(
    "neo_pos_execute_complimentary",
    payload
  );

  if (error) throw new Error(error.message);

  if (
    data?.ok !== true ||
    data.order_id !== orderId ||
    data.order_item_id !== itemId ||
    data.approval_id !== approvalId
  ) {
    throw new Error(
      "Complimentary execution evidence could not be confirmed."
    );
  }

  return data;
}
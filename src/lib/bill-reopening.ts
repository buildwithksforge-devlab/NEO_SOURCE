const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reopeningRequestPayload(
  orderId:string,
  reason:string,
  intentKey:string
) {

  const text=reason.trim();

  if (
    !UUID.test(orderId) ||
    text.length<10 ||
    text.length>4000 ||
    !intentKey.trim() ||
    intentKey.length>200
  ) {
    throw new Error(
      "Valid bill, reopening reason and transaction identity required."
    );
  }

  return {
    _order:orderId,
    _reason:text,
    _intent_key:intentKey,
  };
}

export function reopeningDecisionPayload(
  requestId:string,
  approve:boolean,
  note:string
) {

  const text=note.trim();

  if (
    !UUID.test(requestId) ||
    typeof approve!=="boolean" ||
    text.length<10 ||
    text.length>4000
  ) {
    throw new Error(
      "Valid reopening request and decision reason required."
    );
  }

  return {
    _request:requestId,
    _approve:approve,
    _note:text,
  };
}

export function reopeningExecutionPayload(
  requestId:string
) {

  if (!UUID.test(requestId)) {
    throw new Error(
      "A valid approved reopening request is required."
    );
  }

  return {
    _request:requestId,
  };
}

export function validateReopeningResponse(
  result:any,
  orderId:string,
  requestId?:string,
  execution=false
) {

  if (
    result?.ok!==true ||
    result.order_id!==orderId ||
    !UUID.test(String(result.request_id??"")) ||
    (
      requestId &&
      result.request_id!==requestId
    )
  ) {
    throw new Error(
      "Bill reopening transaction identity could not be confirmed."
    );
  }

  if (
    execution &&
    result.status!=="executed"
  ) {
    throw new Error(
      "Bill reopening execution could not be confirmed."
    );
  }

  return result;
}
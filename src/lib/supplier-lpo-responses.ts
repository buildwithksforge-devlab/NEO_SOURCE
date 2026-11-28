export type SupplierLpoResponseType =
  | "accepted"
  | "declined"
  | "changes-requested";

export type SupplierLpoResponse = {
  id: string;
  response_type: SupplierLpoResponseType;
  promised_delivery_date: string | null;
  notes: string | null;
  submitted_at: string;
};

export function validateSupplierLpoResponse(input: {
  response: SupplierLpoResponseType;
  deliveryDate: string;
  notes: string;
}) {
  if (
    ![
      "accepted",
      "declined",
      "changes-requested",
    ].includes(input.response)
  ) {
    throw new Error("Invalid order response.");
  }

  const notes = input.notes.trim();
  const date = input.deliveryDate.trim();

  if (notes.length > 4000) {
    throw new Error("Response notes are too long.");
  }

  if (
    input.response !== "accepted" &&
    notes.length < 5
  ) {
    throw new Error(
      "Provide a reason for this response."
    );
  }

  if (
    input.response === "accepted" &&
    !date
  ) {
    throw new Error(
      "Select your expected delivery date."
    );
  }

  if (date) {
    const timestamp = Date.parse(
      `${date}T00:00:00Z`
    );

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp)
        .toISOString()
        .slice(0,10) !== date
    ) {
      throw new Error("Invalid delivery date.");
    }
  }

  return {
    response: input.response,
    deliveryDate: date || null,
    notes: notes || null,
  };
}

export function assertSupplierLpoResult(
  data: unknown
): string {
  const result = data as
    | Record<string, unknown>
    | null;

  if (
    !result ||
    result["ok"] !== true ||
    typeof result["response_id"] !== "string" ||
    !result["response_id"]
  ) {
    throw new Error(
      "The purchase order response could not be confirmed."
    );
  }

  return result["response_id"];
}

export function supplierLpoResponseLabel(
  value: string
): string {
  switch (value) {
    case "accepted":
      return "Accepted by supplier";

    case "declined":
      return "Declined by supplier";

    case "changes-requested":
      return "Changes requested";

    default:
      return "Unrecognized response";
  }
}
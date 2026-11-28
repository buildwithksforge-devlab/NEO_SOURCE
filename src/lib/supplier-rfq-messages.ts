export type SupplierMessage = {
  id: string;
  sender_type: "supplier" | "procurement";
  message_body: string;
  created_at: string;
};

export function validateSupplierMessage(
  value: string
): string {
  const body = value.trim();

  if (!body || body.length > 4000) {
    throw new Error(
      "Enter a message between 1 and 4,000 characters."
    );
  }

  return body;
}

export function assertSupplierMessageResult(
  result: unknown
): string {
  const row = result as Record<string, unknown> | null;

  if (
    !row ||
    row["ok"] !== true ||
    typeof row["message_id"] !== "string" ||
    !row["message_id"]
  ) {
    throw new Error(
      "Message submission could not be confirmed."
    );
  }

  return row["message_id"];
}

export function parseSupplierMessages(
  value: unknown
): SupplierMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid message history.");
  }

  return value.map((row) => {
    if (
      !row ||
      typeof row.id !== "string" ||
      !["supplier","procurement"].includes(
        row.sender_type
      ) ||
      typeof row.message_body !== "string" ||
      !Number.isFinite(Date.parse(row.created_at))
    ) {
      throw new Error(
        "Message history contains invalid records."
      );
    }

    return {
      id: row.id,
      sender_type: row.sender_type,
      message_body: row.message_body,
      created_at: row.created_at,
    };
  });
}
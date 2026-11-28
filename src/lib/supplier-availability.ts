export type AvailabilityState =
  | "available"
  | "partial"
  | "unavailable";

export type AvailabilityLine = {
  request_line_id: string;
  available_quantity: number;
  lead_time_days: number | null;
  alternative: string;
  notes: string;
};

export function classifySupplierAvailability(
  requested: number,
  available: number
): AvailabilityState {
  if (
    !Number.isFinite(requested) ||
    requested <= 0 ||
    !Number.isFinite(available) ||
    available < 0 ||
    available > requested
  ) {
    throw new Error("Invalid supplier availability quantity.");
  }

  if (available === 0) return "unavailable";
  if (available === requested) return "available";

  return "partial";
}

export function prepareSupplierAvailabilityLine(input: {
  requestLineId: string;
  requested: number;
  available: string;
  leadTimeDays: string;
  alternative?: string;
  notes?: string;
}): AvailabilityLine {
  if (!input.requestLineId.trim()) {
    throw new Error("Requested item is required.");
  }

  if (!/^\d+(\.\d+)?$/.test(input.available.trim())) {
    throw new Error("Enter a valid available quantity.");
  }

  const available = Number(input.available);

  classifySupplierAvailability(
    input.requested,
    available
  );

  const leadTime = input.leadTimeDays.trim();

  if (leadTime && !/^\d+$/.test(leadTime)) {
    throw new Error("Lead time must be a whole number of days.");
  }

  const days = leadTime ? Number(leadTime) : null;

  if (
    days !== null &&
    (!Number.isFinite(days) || days > 3650)
  ) {
    throw new Error("Delivery lead time is invalid.");
  }

  const alternative = input.alternative?.trim() ?? "";
  const notes = input.notes?.trim() ?? "";

  if (alternative.length > 1000 || notes.length > 1000) {
    throw new Error("Item response notes are too long.");
  }

  return {
    request_line_id: input.requestLineId,
    available_quantity: available,
    lead_time_days: days,
    alternative,
    notes,
  };
}

export function assertAvailabilityResponse(
  data: unknown
): string {
  const result = data as Record<string, unknown> | null;

  if (
    !result ||
    result["ok"] !== true ||
    typeof result["response_id"] !== "string" ||
    !result["response_id"]
  ) {
    throw new Error("Supplier response was not confirmed.");
  }

  return result["response_id"];
}
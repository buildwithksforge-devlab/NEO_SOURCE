/**
 * Aggregates the existing POS reporting row for one
 * employee profile.
 *
 * No cross-employee figures are combined.
 * This never performs a financial posting.
 */

export type EmployeePosActivityRow = {
  profile_id: string;
  orders_created: number | string | null;
  orders_currently_assigned: number | string | null;
  created_orders_finalized: number | string | null;
  created_orders_cancelled: number | string | null;
  created_orders_voided: number | string | null;
  finalized_bill_value: number | string | null;
};

export type EmployeePosActivity = {
  ordersCreated: number;
  currentlyAssigned: number;
  finalized: number;
  cancelled: number;
  voided: number;
  finalizedBillValue: number;
};

function safeAmount(
  value: number | string | null,
): number {
  const number = Number(value ?? 0);

  return Number.isFinite(number)
    ? number
    : 0;
}

export function employeePosActivity(
  rows: readonly EmployeePosActivityRow[],
  profileId: string | null | undefined,
): EmployeePosActivity | null {
  if (!profileId) {
    return null;
  }

  const row = rows.find(
    (item) => item.profile_id === profileId,
  );

  if (!row) {
    return null;
  }

  return {
    ordersCreated: safeAmount(row.orders_created),
    currentlyAssigned: safeAmount(
      row.orders_currently_assigned,
    ),
    finalized: safeAmount(
      row.created_orders_finalized,
    ),
    cancelled: safeAmount(
      row.created_orders_cancelled,
    ),
    voided: safeAmount(
      row.created_orders_voided,
    ),
    finalizedBillValue: safeAmount(
      row.finalized_bill_value,
    ),
  };
}

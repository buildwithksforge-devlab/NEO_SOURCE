export type CustomerAdvanceDeposit = {
  id: string;
  receipt_number: string;
  currency: string;
  original_amount: number;
  allocated_amount: number;
  refunded_amount: number;
  available_amount: number;
  received_at: string;
};

export function validateCustomerDepositAmount(
  amount: string
): number {
  const value = amount.trim();

  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error(
      "Enter a positive amount with up to two decimal places."
    );
  }

  const result = Number(value);

  if (
    !Number.isFinite(result) ||
    result <= 0 ||
    result > Number.MAX_SAFE_INTEGER / 100
  ) {
    throw new Error("Invalid deposit amount.");
  }

  return result;
}

export function validateCustomerDepositAllocation(
  amount: string,
  available: number,
  outstanding: number
): number {
  const value = validateCustomerDepositAmount(amount);

  if (
    !Number.isFinite(available) ||
    available < 0 ||
    !Number.isFinite(outstanding) ||
    outstanding < 0
  ) {
    throw new Error(
      "The deposit or invoice position is not verified."
    );
  }

  if (value > available) {
    throw new Error(
      "Allocation exceeds the available deposit."
    );
  }

  if (value > outstanding) {
    throw new Error(
      "Allocation exceeds the outstanding invoice."
    );
  }

  return value;
}

export function summarizeCustomerDeposits(
  deposits: CustomerAdvanceDeposit[]
) {
  const currencies = new Map<
    string,
    {
      received: number;
      allocated: number;
      refunded: number;
      available: number;
    }
  >();

  const seen = new Set<string>();

  for (const row of deposits) {
    if (!row.id || seen.has(row.id)) {
      throw new Error("Duplicate or invalid deposit identity.");
    }

    seen.add(row.id);

    const currency = row.currency.toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Invalid deposit currency.");
    }

    const amounts = [
      Number(row.original_amount),
      Number(row.allocated_amount),
      Number(row.refunded_amount),
      Number(row.available_amount),
    ];

    if (
      amounts.some(
        (value) => !Number.isFinite(value) || value < 0
      )
    ) {
      throw new Error("Invalid deposit financial position.");
    }

    const [received, allocated, refunded, available] = amounts;

    if (
      received === undefined ||
      allocated === undefined ||
      refunded === undefined ||
      available === undefined ||
      !Number.isFinite(received) ||
      !Number.isFinite(allocated) ||
      !Number.isFinite(refunded) ||
      !Number.isFinite(available)
    ) {
      throw new Error("Customer deposit financial amounts require reconciliation.");
    }

    if (
      Math.abs(
        received - allocated - refunded - available
      ) > 0.005
    ) {
      throw new Error("Deposit reconciliation mismatch.");
    }

    const current = currencies.get(currency) ?? {
      received: 0,
      allocated: 0,
      refunded: 0,
      available: 0,
    };

    current.received += received;
    current.allocated += allocated;
    current.refunded += refunded;
    current.available += available;

    currencies.set(currency,current);
  }

  return [...currencies.entries()].map(
    ([currency,position]) => ({
      currency,
      ...position,
    })
  );
}
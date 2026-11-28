export interface ReservationDepositBalance {
  id: string;
  originalAmount: number;
  appliedAmount: number;
  refundedAmount: number;
  reservedRefundAmount?: number;
}

export interface DepositAllocation {
  depositId: string;
  amount: number;
}

function cents(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid monetary amount");
  }

  const scaled = value * 100;
  const rounded = Math.round(scaled);

  if (
    !Number.isSafeInteger(rounded) ||
    Math.abs(scaled - rounded) > 0.000001
  ) {
    throw new Error("Amount must be represented in valid cents");
  }

  return rounded;
}

function addCents(a: number, b: number): number {
  const total = a + b;

  if (!Number.isSafeInteger(total)) {
    throw new Error("Monetary total exceeds safe precision");
  }

  return total;
}

export function allocateReservationDeposit(
  outstandingCharge: number,
  deposits: ReservationDepositBalance[]
) {
  const charge = cents(outstandingCharge);

  let outstanding = charge;
  let applied = 0;
  let remainingDeposit = 0;
  let reservedRefunds = 0;

  const allocations: DepositAllocation[] = [];
  const identities = new Set<string>();

  const updatedDeposits = deposits.map((deposit) => {
    if (!deposit.id.trim() || identities.has(deposit.id)) {
      throw new Error("Invalid or duplicate deposit identity");
    }

    identities.add(deposit.id);

    const original = cents(deposit.originalAmount);
    const previous = cents(deposit.appliedAmount);
    const refunded = cents(deposit.refundedAmount);
    const reserved = cents(deposit.reservedRefundAmount ?? 0);

    const consumed = addCents(previous, refunded);
    const committed = addCents(consumed, reserved);

    if (committed > original) {
      throw new Error("Deposit balances require reconciliation");
    }

    const available = original - committed;
    const allocation = Math.min(outstanding, available);

    outstanding -= allocation;
    applied = addCents(applied, allocation);

    remainingDeposit = addCents(
      remainingDeposit,
      original - consumed - allocation
    );

    reservedRefunds = addCents(reservedRefunds, reserved);

    if (allocation > 0) {
      allocations.push({
        depositId: deposit.id,
        amount: allocation / 100
      });
    }

    return {
      ...deposit,
      appliedAmount: (previous + allocation) / 100
    };
  });

  return {
    charge: charge / 100,
    applied: applied / 100,
    outstanding: outstanding / 100,
    remainingDeposit: remainingDeposit / 100,
    reservedRefunds: reservedRefunds / 100,
    availableDeposit: (remainingDeposit - reservedRefunds) / 100,
    allocations,
    deposits: updatedDeposits
  };
}

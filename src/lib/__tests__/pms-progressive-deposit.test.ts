import { describe, expect, it } from "vitest";
import {
  allocateReservationDeposit,
  type ReservationDepositBalance
} from "../pms-progressive-deposit";

const deposit = (
  amount = 50000,
  applied = 0,
  refunded = 0,
  reserved = 0,
  id = "deposit-1"
): ReservationDepositBalance => ({
  id,
  originalAmount: amount,
  appliedAmount: applied,
  refundedAmount: refunded,
  reservedRefundAmount: reserved
});

describe("progressive accommodation deposit allocation", () => {
  it("retains the unused deposit after the first night", () => {
    const result = allocateReservationDeposit(
      19000,
      [deposit()]
    );

    expect(result.applied).toBe(19000);
    expect(result.remainingDeposit).toBe(31000);
    expect(result.outstanding).toBe(0);
  });

  it("progressively consumes the deposit over three nights", () => {
    const first = allocateReservationDeposit(19000, [deposit()]);

    const second = allocateReservationDeposit(
      19000,
      first.deposits
    );

    expect(second.remainingDeposit).toBe(12000);
    expect(second.outstanding).toBe(0);

    const third = allocateReservationDeposit(
      19000,
      second.deposits
    );

    expect(third.applied).toBe(12000);
    expect(third.remainingDeposit).toBe(0);
    expect(third.outstanding).toBe(7000);
  });

  it("preserves unpaid accommodation when no deposit exists", () => {
    const result = allocateReservationDeposit(19000, []);

    expect(result.applied).toBe(0);
    expect(result.outstanding).toBe(19000);
  });

  it("does not allocate more than a partial deposit", () => {
    const result = allocateReservationDeposit(
      19000,
      [deposit(5000)]
    );

    expect(result.applied).toBe(5000);
    expect(result.outstanding).toBe(14000);
  });

  it("retains excess guest deposits as unused balances", () => {
    const result = allocateReservationDeposit(
      10000,
      [deposit(50000)]
    );

    expect(result.remainingDeposit).toBe(40000);
  });

  it("allocates across multiple deposits in supplied order", () => {
    const result = allocateReservationDeposit(19000, [
      deposit(10000, 0, 0, 0, "first"),
      deposit(15000, 0, 0, 0, "second")
    ]);

    expect(result.allocations).toEqual([
      { depositId: "first", amount: 10000 },
      { depositId: "second", amount: 9000 }
    ]);

    expect(result.remainingDeposit).toBe(6000);
  });

  it("excludes money already refunded", () => {
    const result = allocateReservationDeposit(
      19000,
      [deposit(20000, 0, 5000)]
    );

    expect(result.applied).toBe(15000);
    expect(result.outstanding).toBe(4000);
  });

  it("protects reserved refund amounts", () => {
    const result = allocateReservationDeposit(
      19000,
      [deposit(20000, 0, 0, 8000)]
    );

    expect(result.applied).toBe(12000);
    expect(result.remainingDeposit).toBe(8000);
    expect(result.availableDeposit).toBe(0);
    expect(result.outstanding).toBe(7000);
  });

  it("does not consume deposits against a zero charge", () => {
    const result = allocateReservationDeposit(0, [deposit()]);

    expect(result.allocations).toEqual([]);
    expect(result.remainingDeposit).toBe(50000);
  });

  it("handles monetary cents without cumulative rounding drift", () => {
    const result = allocateReservationDeposit(
      0.3,
      [deposit(0.1, 0, 0, 0, "a"),
       deposit(0.2, 0, 0, 0, "b")]
    );

    expect(result.applied).toBe(0.3);
    expect(result.outstanding).toBe(0);
  });

  it("does not mutate the original receipt balances", () => {
    const original = deposit();

    allocateReservationDeposit(19000, [original]);

    expect(original.originalAmount).toBe(50000);
    expect(original.appliedAmount).toBe(0);
  });

  it("rejects duplicate deposit identities", () => {
    expect(() =>
      allocateReservationDeposit(19000, [deposit(), deposit()])
    ).toThrow(/duplicate/i);
  });

  it("rejects missing deposit identities", () => {
    expect(() =>
      allocateReservationDeposit(
        19000,
        [deposit(50000, 0, 0, 0, "")]
      )
    ).toThrow(/identity/i);
  });

  it("rejects an overallocated deposit", () => {
    expect(() =>
      allocateReservationDeposit(
        19000,
        [deposit(5000, 6000)]
      )
    ).toThrow(/reconciliation/i);
  });

  it("rejects combined allocations and refunds exceeding the receipt", () => {
    expect(() =>
      allocateReservationDeposit(
        19000,
        [deposit(50000, 30000, 25000)]
      )
    ).toThrow(/reconciliation/i);
  });

  it("rejects refund reservations exceeding the unused balance", () => {
    expect(() =>
      allocateReservationDeposit(
        19000,
        [deposit(50000, 30000, 0, 25000)]
      )
    ).toThrow(/reconciliation/i);
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.001])(
    "rejects invalid charge amount %s",
    (value) => {
      expect(() =>
        allocateReservationDeposit(value, [deposit()])
      ).toThrow();
    }
  );

  it.each([NaN, Infinity, -Infinity, -1, 0.001])(
    "rejects invalid deposit amount %s",
    (value) => {
      expect(() =>
        allocateReservationDeposit(19000, [deposit(value)])
      ).toThrow();
    }
  );

  it("preserves the checkout balance after restaurant charges", () => {
    const first = allocateReservationDeposit(19000, [deposit()]);
    const second = allocateReservationDeposit(19000, first.deposits);
    const third = allocateReservationDeposit(19000, second.deposits);

    expect(third.outstanding + 3000).toBe(10000);
  });
});

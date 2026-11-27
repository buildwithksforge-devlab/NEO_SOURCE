import { describe, expect, it } from "vitest";

import {
  saveRepaymentRecovery,
  readRepaymentRecovery,
  clearRepaymentRecovery,
} from "../customer-repayment-recovery";

function memoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
  };
}

const scope = {
  organizationId: "org-1",
  userId: "cashier-1",
  customerId: "customer-1",
};

const input = {
  invoiceId: "invoice-1",
  amount: "1500",
  method: "cash",
  reference: "",
  notes: "Private note",
  accountId: "account-1",
  intentKey: "attempt-1",
};

describe("customer repayment recovery", () => {

  it("restores the original transaction identity", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, input);

    expect(
      readRepaymentRecovery(storage, scope)?.intentKey
    ).toBe("attempt-1");
  });

  it("restores the original amount and invoice", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, input);

    const saved = readRepaymentRecovery(storage, scope);

    expect(saved?.amount).toBe("1500");
    expect(saved?.invoiceId).toBe("invoice-1");
  });

  it("does not expose another cashier's recovery", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, input);

    expect(readRepaymentRecovery(storage, {
      ...scope,
      userId: "cashier-2",
    })).toBeNull();
  });

  it("does not expose another organization's recovery", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, input);

    expect(readRepaymentRecovery(storage, {
      ...scope,
      organizationId: "org-2",
    })).toBeNull();
  });

  it("does not expose another customer's recovery", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, input);

    expect(readRepaymentRecovery(storage, {
      ...scope,
      customerId: "customer-2",
    })).toBeNull();
  });

  it("clears confirmed repayment recovery", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, input);

    clearRepaymentRecovery(storage, scope);

    expect(readRepaymentRecovery(storage, scope)).toBeNull();
  });

  it("does not persist private free-text notes", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, input);

    expect(
      readRepaymentRecovery(storage, scope)?.notes
    ).toBe("");
  });

  it("rejects invalid saved payment amounts", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, {
      ...input,
      amount: "Infinity",
    });

    expect(() =>
      readRepaymentRecovery(storage, scope)
    ).toThrow();
  });

  it("rejects corrupted recovery information", () => {
    const storage = memoryStorage();

    saveRepaymentRecovery(storage, scope, input);

    const key = storage.key(0);

    if (!key) throw new Error("Missing test storage key");

    storage.setItem(key, "{broken");

    expect(() =>
      readRepaymentRecovery(storage, scope)
    ).toThrow();
  });

});
import type {
  CustomerRepaymentInput,
} from "@/lib/customer-repayment";

export type RepaymentRecoveryScope = {
  organizationId: string;
  userId: string;
  customerId: string;
};

function recoveryKey(scope: RepaymentRecoveryScope) {
  return [
    "neo",
    "customer-repayment",
    "v1",
    scope.organizationId,
    scope.userId,
    scope.customerId,
  ].join(":");
}

export function saveRepaymentRecovery(
  storage: Storage,
  scope: RepaymentRecoveryScope,
  input: CustomerRepaymentInput
) {
  // Do not store customer names or free-text notes.
  const recovery = {
    invoiceId: input.invoiceId,
    amount: input.amount,
    method: input.method,
    reference: input.reference,
    notes: "",
    accountId: input.accountId,
    intentKey: input.intentKey,
  };

  storage.setItem(
    recoveryKey(scope),
    JSON.stringify(recovery)
  );
}

export function readRepaymentRecovery(
  storage: Storage,
  scope: RepaymentRecoveryScope
): CustomerRepaymentInput | null {
  const raw = storage.getItem(recoveryKey(scope));

  if (!raw) return null;

  const value = JSON.parse(raw) as Record<string, unknown>;

  for (const key of [
    "invoiceId",
    "amount",
    "method",
    "reference",
    "notes",
    "accountId",
    "intentKey",
  ]) {
    if (typeof value[key] !== "string") {
      throw new Error(
        "Saved repayment recovery is invalid. Financial review is required."
      );
    }
  }

  const amount = Number(value["amount"]);

  if (
    !value["invoiceId"] ||
    !value["intentKey"] ||
    !value["accountId"] ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Saved repayment recovery is incomplete. Financial review is required."
    );
  }

  return value as CustomerRepaymentInput;
}

export function clearRepaymentRecovery(
  storage: Storage,
  scope: RepaymentRecoveryScope
) {
  storage.removeItem(recoveryKey(scope));
}
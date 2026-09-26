/**
 * Canonical command outcome vocabulary.
 *
 * A command is never reported as successful because a request left the browser.
 * Every significant action resolves to exactly one of these outcomes, derived
 * from the persisted canonical record the backend returned — never from the
 * absence of an exception.
 */
export type CommandStatus =
  | "requested"
  | "processing"
  | "persisted"
  | "completed"
  | "blocked"
  | "failed"
  | "reversed";

export type CommandOutcome = {
  status: CommandStatus;
  /** Plain-language sentence shown to the operator. */
  message: string;
  /** Why an outcome is blocked or failed, when the backend explained it. */
  reason?: string;
};

/** Outcomes that may be announced with a success tone. */
export const SUCCESS_STATUSES: CommandStatus[] = ["persisted", "completed", "reversed"];

/** Outcomes that stop the workflow and must never read as success. */
export const HALT_STATUSES: CommandStatus[] = ["blocked", "failed"];

export function isSuccess(status: CommandStatus): boolean {
  return SUCCESS_STATUSES.includes(status);
}

export function isHalt(status: CommandStatus): boolean {
  return HALT_STATUSES.includes(status);
}

export function outcome(
  status: CommandStatus,
  message: string,
  reason?: string,
): CommandOutcome {
  return reason === undefined ? { status, message } : { status, message, reason };
}

/**
 * Settlement reconciliation outcome.
 *
 * Reconciling an unpaid or partly paid bill is a legitimate, useful action —
 * but it is not a closure, and it must not be announced as one.
 */
export function settlementOutcome(input: {
  closed?: boolean | null;
  payment_status?: string | null;
  balance?: number | null;
  open_items?: number | null;
  grand_total?: number | null;
}): CommandOutcome {
  const balance = Number(input.balance ?? 0);
  const openItems = Number(input.open_items ?? 0);
  const status = String(input.payment_status ?? "unpaid");

  if (input.closed) {
    return outcome("completed", "Bill settled in full and closed.");
  }
  if (Number(input.grand_total ?? 0) <= 0) {
    return outcome(
      "blocked",
      "Nothing to reconcile — this bill has no chargeable lines yet.",
      "no-chargeable-lines",
    );
  }
  if (balance > 0.005) {
    return outcome(
      "persisted",
      `Payments recorded — the bill remains ${status} with an outstanding balance.`,
      "outstanding-balance",
    );
  }
  if (openItems > 0) {
    return outcome(
      "persisted",
      "Payments recorded — the bill stays open until every item is served or voided.",
      "open-items",
    );
  }
  return outcome("persisted", "Payments recorded against this bill.");
}

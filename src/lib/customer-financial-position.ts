type Row = Record<string, unknown>;

export type CustomerFinancialPosition = {
  currency: string;
  billed: number;
  outstanding: number;
  postedReceipts: number;
  pendingReceipts: number;
  credited: number;
  current: number;
  overdue30: number;
  overdue60: number;
  overdue90: number;
  overdueBeyond90: number;
  invalidRecords: number;
};

function amount(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) && n >= 0 ? n : null;
}

function state(row: Row) {
  return String(row["status"] ?? "").trim().toLowerCase();
}

function currency(row: Row) {
  return (
    String(row["currency"] ?? "").trim().toUpperCase() ||
    "UNSPECIFIED"
  );
}

const confirmed = new Set([
  "confirmed",
  "completed",
  "paid",
  "settled",
  "captured",
]);

const pending = new Set([
  "pending",
  "processing",
  "submitted",
  "pending-verification",
  "pending_verification",
]);

const excludedInvoices = new Set([
  "draft",
  "cancelled",
  "canceled",
  "voided",
  "reversed",
]);

export function customerFinancialPosition(
  invoices: Row[],
  payments: Row[],
  creditNotes: Row[],
  asOf = new Date()
): CustomerFinancialPosition[] {
  const groups = new Map<string, CustomerFinancialPosition>();

  function get(row: Row) {
    const key = currency(row);

    let group = groups.get(key);

    if (!group) {
      group = {
        currency: key,
        billed: 0,
        outstanding: 0,
        postedReceipts: 0,
        pendingReceipts: 0,
        credited: 0,
        current: 0,
        overdue30: 0,
        overdue60: 0,
        overdue90: 0,
        overdueBeyond90: 0,
        invalidRecords: 0,
      };

      groups.set(key, group);
    }

    return group;
  }

  for (const row of invoices) {
    const status = state(row);

    if (excludedInvoices.has(status)) continue;

    const group = get(row);

    const total = amount(row["total"]);
    const balance = amount(row["balance"]);

    if (
      !status ||
      total === null ||
      balance === null ||
      balance > total
    ) {
      group.invalidRecords += 1;
      continue;
    }

    group.billed += total;
    group.outstanding += balance;

    if (balance === 0) continue;

    const due = row["due_date"]
      ? Date.parse(String(row["due_date"]))
      : Number.NaN;

    if (!Number.isFinite(due)) {
      group.current += balance;
      group.invalidRecords += 1;
      continue;
    }

    const days = Math.floor(
      (asOf.getTime() - due) / 86400000
    );

    if (days <= 0) group.current += balance;
    else if (days <= 30) group.overdue30 += balance;
    else if (days <= 60) group.overdue60 += balance;
    else if (days <= 90) group.overdue90 += balance;
    else group.overdueBeyond90 += balance;
  }

  for (const row of payments) {
    const status = state(row);

    if (
      !confirmed.has(status) &&
      !pending.has(status)
    ) {
      continue;
    }

    const group = get(row);
    const received = amount(row["amount"]);

    if (received === null) {
      group.invalidRecords += 1;
      continue;
    }

    if (
      confirmed.has(status) &&
      row["posted_journal_id"]
    ) {
      group.postedReceipts += received;
    } else {
      group.pendingReceipts += received;
    }
  }

  for (const row of creditNotes) {
    const status = state(row);

    if (
      !new Set([
        "issued",
        "posted",
        "approved",
        "applied",
        "completed",
      ]).has(status)
    ) {
      continue;
    }

    const group = get(row);
    const credited = amount(row["total"]);

    if (credited === null) {
      group.invalidRecords += 1;
      continue;
    }

    group.credited += credited;
  }

  return [...groups.values()].map((group) => {
    const result = { ...group };

    for (const key of [
      "billed",
      "outstanding",
      "postedReceipts",
      "pendingReceipts",
      "credited",
      "current",
      "overdue30",
      "overdue60",
      "overdue90",
      "overdueBeyond90",
    ] as const) {
      result[key] = Math.round(result[key] * 100) / 100;
    }

    return result;
  });
}
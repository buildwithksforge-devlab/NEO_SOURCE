export interface CashierCollectionRow {
  id: string;
  amount: number | string | null;
  currency: string | null;
  method: string | null;
  status: string | null;
  created_at: string | null;
  source_module?: string | null;
  source_record_id?: string | null;
  reference?: string | null;
}

export interface CollectionMethodSummary {
  method: string;
  count: number;
  amount: number;
}

export interface CashierCollectionSummary {
  currency: string;
  confirmed: number;
  pending: number;
  refunded: number;
  other: number;
  confirmedCount: number;
  pendingCount: number;
  refundedCount: number;
  otherCount: number;
  averageCollection: number;
  methods: CollectionMethodSummary[];
}

const CONFIRMED = new Set([
  "confirmed",
  "paid",
  "completed",
  "captured",
  "settled",
]);

const PENDING = new Set([
  "pending",
  "submitted",
  "processing",
  "pending-verification",
  "pending_verification",
]);

const REFUNDED = new Set([
  "refunded",
  "reversed",
]);

export function collectionStatusGroup(status: unknown) {
  const value = String(status ?? "").trim().toLowerCase();

  if (CONFIRMED.has(value)) return "confirmed";
  if (PENDING.has(value)) return "pending";
  if (REFUNDED.has(value)) return "refunded";

  return "other";
}

export function summarizeCashierCollections(
  rows: CashierCollectionRow[]
): CashierCollectionSummary[] {
  const groups = new Map<
    string,
    {
      summary: CashierCollectionSummary;
      methods: Map<string, CollectionMethodSummary>;
    }
  >();

  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;

    seen.add(row.id);

    const amount = Number(row.amount);

    if (
      row.amount === null ||
      (typeof row.amount === "string" && row.amount.trim() === "") ||
      !Number.isFinite(amount) ||
      amount < 0
    ) {
      continue;
    }

    const currency =
      String(row.currency ?? "").trim().toUpperCase() ||
      "UNSPECIFIED";

    let group = groups.get(currency);

    if (!group) {
      group = {
        summary: {
          currency,
          confirmed: 0,
          pending: 0,
          refunded: 0,
          other: 0,
          confirmedCount: 0,
          pendingCount: 0,
          refundedCount: 0,
          otherCount: 0,
          averageCollection: 0,
          methods: [],
        },
        methods: new Map(),
      };

      groups.set(currency, group);
    }

    const summary = group.summary;
    const state = collectionStatusGroup(row.status);

    if (state === "confirmed") {
      summary.confirmed += amount;
      summary.confirmedCount += 1;

      const method =
        String(row.method ?? "").trim().toLowerCase() ||
        "unspecified";

      const previous = group.methods.get(method) ?? {
        method,
        count: 0,
        amount: 0,
      };

      previous.count += 1;
      previous.amount += amount;

      group.methods.set(method, previous);
    } else if (state === "pending") {
      summary.pending += amount;
      summary.pendingCount += 1;
    } else if (state === "refunded") {
      summary.refunded += amount;
      summary.refundedCount += 1;
    } else {
      summary.other += amount;
      summary.otherCount += 1;
    }
  }

  return [...groups.values()].map(({ summary, methods }) => ({
    ...summary,
    confirmed: Math.round(summary.confirmed * 100) / 100,
    pending: Math.round(summary.pending * 100) / 100,
    refunded: Math.round(summary.refunded * 100) / 100,
    other: Math.round(summary.other * 100) / 100,
    averageCollection:
      summary.confirmedCount > 0
        ? Math.round(
            (summary.confirmed / summary.confirmedCount) * 100
          ) / 100
        : 0,
    methods: [...methods.values()]
      .map((method) => ({
        ...method,
        amount: Math.round(method.amount * 100) / 100,
      }))
      .sort((a, b) => b.amount - a.amount),
  }));
}

export function cashierDateRange(
  period: "today" | "week" | "month",
  now = new Date()
) {
  const start = new Date(now);
  const end = new Date(now);

  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  if (period === "week") {
    start.setDate(start.getDate() - 6);
  }

  if (period === "month") {
    start.setDate(1);
  }

  end.setDate(end.getDate() + 1);

  return {
    from: start.toISOString(),
    to: end.toISOString(),
  };
}
import { useMemo, useState } from "react";
import { useCashierPersonalCollections } from "@/lib/cashier-personal-collections";
import {
  cashierDateRange,
  collectionStatusGroup,
  summarizeCashierCollections,
} from "@/lib/cashier-collection-analysis";

type Period = "today" | "week" | "month" | "custom";

function money(amount: number) {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CashierCollectionReport() {
  const [period, setPeriod] = useState<Period>("today");
  const [method, setMethod] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const range = useMemo(() => {
    if (period !== "custom") {
      return cashierDateRange(period);
    }

    if (!customFrom || !customTo || customFrom > customTo) {
      return { from: "", to: "" };
    }

    const start = new Date(`${customFrom}T00:00:00`);
    const end = new Date(`${customTo}T00:00:00`);

    end.setDate(end.getDate() + 1);

    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end.getTime() - start.getTime() > 366 * 86400000
    ) {
      return { from: "", to: "" };
    }

    return {
      from: start.toISOString(),
      to: end.toISOString(),
    };
  }, [period, customFrom, customTo]);

  const query = useCashierPersonalCollections(
    range.from,
    range.to
  );

  const rows = query.data ?? [];

  const methods = useMemo(
    () =>
      [...new Set(
        rows.map(
          (r) => String(r.method ?? "unspecified")
        )
      )].sort(),
    [rows]
  );

  const visible = useMemo(
    () =>
      rows.filter(
        (r) =>
          method === "all" ||
          String(r.method ?? "unspecified") === method
      ),
    [rows, method]
  );

  const summaries = useMemo(
    () => summarizeCashierCollections(visible),
    [visible]
  );

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            My collection history
          </h2>
          <p className="text-sm text-muted-foreground">
            Collections attributed to your authenticated account
            at the selected property.
          </p>
        </div>

        <button
          type="button"
          onClick={() => query.refetch()}
          disabled={query.isFetching || !range.from || !range.to}
          className="rounded-md border px-3 py-2 text-sm"
        >
          {query.isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {([
          ["today", "Today"],
          ["week", "Last 7 days"],
          ["month", "This month"],
          ["custom", "Custom dates"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setPeriod(value)}
            className={`rounded-md border px-3 py-2 text-sm ${
              period === value ? "bg-muted font-semibold" : ""
            }`}
          >
            {label}
          </button>
        ))}

        <select
          aria-label="Payment method"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All payment methods</option>
          {methods.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      {period === "custom" && (
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">
            From
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="ml-2 rounded-md border bg-background p-2"
            />
          </label>

          <label className="text-sm">
            To
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="ml-2 rounded-md border bg-background p-2"
            />
          </label>
        </div>
      )}

      {(!range.from || !range.to) && (
        <p role="alert" className="text-sm text-destructive">
          Select a valid reporting period of up to 366 days.
        </p>
      )}

      {query.isLoading && (
        <p className="text-sm text-muted-foreground">
          Loading your collection records...
        </p>
      )}

      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error instanceof Error
            ? query.error.message
            : "Unable to load collection records."}
        </p>
      )}

      {summaries.map((summary) => (
        <div key={summary.currency} className="space-y-3">
          <h3 className="font-semibold">
            {summary.currency}
          </h3>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Confirmed collections
              </p>
              <p className="text-xl font-semibold">
                {money(summary.confirmed)}
              </p>
              <p className="text-xs">
                {summary.confirmedCount} transactions
              </p>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Pending collections
              </p>
              <p className="text-xl font-semibold">
                {money(summary.pending)}
              </p>
              <p className="text-xs">
                {summary.pendingCount} transactions
              </p>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Refunded / reversed records
              </p>
              <p className="text-xl font-semibold">
                {money(summary.refunded)}
              </p>
              <p className="text-xs">
                {summary.refundedCount} transactions
              </p>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Average confirmed collection
              </p>
              <p className="text-xl font-semibold">
                {money(summary.averageCollection)}
              </p>
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <h4 className="mb-2 text-sm font-medium">
              Confirmed payment-method breakdown
            </h4>

            {summary.methods.map((item) => (
              <div
                key={item.method}
                className="flex justify-between gap-3 border-b py-2 text-sm"
              >
                <span>
                  {item.method} ({item.count})
                </span>
                <span className="font-medium">
                  {money(item.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="p-2">Date</th>
              <th className="p-2">Department</th>
              <th className="p-2">Method</th>
              <th className="p-2">Status</th>
              <th className="p-2">Reference</th>
              <th className="p-2 text-right">Amount</th>
            </tr>
          </thead>

          <tbody>
            {visible.map((row) => (
              <tr key={row.id} className="border-b">
                <td className="p-2">
                  {row.created_at
                    ? new Date(row.created_at).toLocaleString()
                    : "-"}
                </td>
                <td className="p-2">
                  {row.source_module ?? "-"}
                </td>
                <td className="p-2">
                  {row.method ?? "-"}
                </td>
                <td className="p-2">
                  {row.status ?? "unknown"}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({collectionStatusGroup(row.status)})
                  </span>
                </td>
                <td className="p-2">
                  {row.reference ?? row.source_record_id ?? "-"}
                </td>
                <td className="p-2 text-right">
                  {row.currency ?? ""} {money(Number(row.amount))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!query.isLoading &&
          !query.error &&
          query.isSuccess && visible.length === 0 && (
            <p className="py-5 text-center text-sm text-muted-foreground">
              No collection records in the selected period.
            </p>
          )}
      </div>

      <p className="text-xs text-muted-foreground">
        This report describes recorded collections. It is not a
        replacement for shift closing, ledger reconciliation or
        controlled refund settlement.
      </p>
    </section>
  );
}
import { useMemo } from "react";
import {
  customerFinancialPosition,
} from "@/lib/customer-financial-position";

type Row = Record<string, unknown>;

type Props = {
  invoices: Row[];
  payments: Row[];
  creditNotes: Row[];
  loading: boolean;
  failed: boolean;
};

function money(value: number) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CustomerFinancialPosition({
  invoices,
  payments,
  creditNotes,
  loading,
  failed,
}: Props) {
  const positions = useMemo(
    () => customerFinancialPosition(
      invoices,
      payments,
      creditNotes
    ),
    [invoices, payments, creditNotes]
  );

  if (failed) {
    return (
      <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">
        Customer financial records could not be verified.
        Do not rely on an incomplete balance.
      </p>
    );
  }

  if (loading) {
    return (
      <p className="rounded-lg border p-4 text-sm">
        Loading customer financial position...
      </p>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold">
          Customer financial position
        </h2>

        <p className="text-sm text-muted-foreground">
          Recorded invoices, posted receipts and outstanding
          obligations, separated by currency.
        </p>
      </div>

      {!positions.length && (
        <p className="text-sm text-muted-foreground">
          No eligible financial records were returned.
        </p>
      )}

      {positions.map((position) => (
        <div key={position.currency} className="space-y-3">
          <h3 className="font-semibold">
            {position.currency}
          </h3>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {[
              ["Billed", position.billed],
              ["Outstanding", position.outstanding],
              ["Posted receipts", position.postedReceipts],
              ["Pending / unposted receipts", position.pendingReceipts],
              ["Credit notes", position.credited],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="rounded-lg border p-3"
              >
                <p className="text-xs text-muted-foreground">
                  {label}
                </p>

                <p className="text-lg font-semibold">
                  {money(Number(value))}
                </p>
              </div>
            ))}
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <h4 className="text-sm font-medium">
              Outstanding invoice aging
            </h4>

            {[
              ["Current / due date unavailable", position.current],
              ["1–30 days overdue", position.overdue30],
              ["31–60 days overdue", position.overdue60],
              ["61–90 days overdue", position.overdue90],
              ["Over 90 days overdue", position.overdueBeyond90],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="flex justify-between gap-3 border-b py-2 text-sm"
              >
                <span>{label}</span>

                <span className="font-medium">
                  {money(Number(value))}
                </span>
              </div>
            ))}
          </div>

          {position.invalidRecords > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {position.invalidRecords} financial record(s)
              require review. Totals may be incomplete.
            </p>
          )}
        </div>
      ))}

      <p className="text-xs text-muted-foreground">
        Invoice balances are not available deposit balances.
        Credit eligibility and deposit utilisation require
        the corresponding authorised transaction workflow.
      </p>
    </section>
  );
}
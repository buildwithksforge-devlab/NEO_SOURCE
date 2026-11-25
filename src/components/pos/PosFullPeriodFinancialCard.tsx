import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/pos";
import { usePosFullPeriodFinancialEvidence } from "@/lib/pos-data";

export function PosFullPeriodFinancialCard({
  from,
  to,
}: {
  from: string;
  to: string;
}) {
  const query = usePosFullPeriodFinancialEvidence(from, to);
  const row = query.data;

  const amount = (
    value: number | string | null | undefined,
  ) => Number(value ?? 0);

  const metrics = row
    ? [
        {
          label: "Finalized orders",
          value: String(amount(row.finalized_order_count)),
        },
        {
          label: "Finalized bill value",
          value: money(amount(row.finalized_bill_value)),
        },
        {
          label: "Finalized discounts",
          value: money(amount(row.finalized_discount_value)),
        },
        {
          label: "Confirmed POS collections",
          value: money(amount(row.confirmed_collection_value)),
        },
        {
          label: "Confirmed payment count",
          value: String(amount(row.confirmed_payment_count)),
        },
        {
          label: "Room-charge payment evidence",
          value: money(amount(row.room_charge_payment_value)),
        },
        {
          label: "Room-charge payment count",
          value: String(amount(row.room_charge_payment_count)),
        },
        {
          label: "Processed refund evidence",
          value: money(amount(row.processed_refund_value)),
        },
        {
          label: "Processed refund count",
          value: String(amount(row.processed_refund_count)),
        },
      ]
    : [];

  return (
    <SectionCard
      title="Full-Period POS Financial Evidence"
      description="Database-side financial activity across the selected period. Not a Finance general-ledger revenue statement."
    >
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">
          Loading full-period financial evidence...
        </p>
      ) : query.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-destructive">
            Financial evidence is unavailable.
            Verify the selected property, reporting dates,
            database permissions and installed SQL migration.
          </p>

          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {metrics.map((metric) => (
              <div
                key={metric.label}
                className="rounded-lg border p-4"
              >
                <p className="text-xs text-muted-foreground">
                  {metric.label}
                </p>

                <p className="mt-2 text-xl font-semibold tabular-nums">
                  {metric.value}
                </p>
              </div>
            ))}
          </div>

          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              Finalized bills use closure dates. Collections
              use payment dates. Processed refund evidence
              currently uses decision dates.
            </p>

            <p>
              Room-charge evidence does not by itself confirm
              that a matching folio transaction was posted.
            </p>

            <p>
              These figures are separate financial measurements.
              They must not be added together as revenue.
            </p>
          </div>

          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching
              ? "Refreshing..."
              : "Refresh financial evidence"}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

import { SectionCard } from "@/components/common/DataDisplay";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/pos";
import {
  usePosCollectionEvidence,
  usePosStaffDisplayNames,
} from "@/lib/pos-data";

import {
  posReportingErrorMessage,
} from "@/lib/pos-reporting-errors";

export function PosCollectionEvidenceCard({
  from,
  to,
}: {
  from: string;
  to: string;
}) {
  const query = usePosCollectionEvidence(from, to);
  const rows = query.data ?? [];

  const staffNames = usePosStaffDisplayNames(
    rows.map((row) => row.cashier_profile_id),
  );

  const amount = (
    value: number | string | null | undefined,
  ) => Number(value ?? 0);

  const confirmedTotal = rows.reduce(
    (sum, row) =>
      sum + amount(row.confirmed_collection_amount),
    0,
  );

  const refundTotal = rows.reduce(
    (sum, row) =>
      sum + amount(row.processed_refund_amount),
    0,
  );

  return (
    <SectionCard
      title="Cashier Collection Performance"
      description="Confirmed POS payment activity and processed refund evidence. These amounts are not Finance-reconciled revenue."
    >
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">
          Loading cashier collection evidence...
        </p>
      ) : query.isError ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">
            {posReportingErrorMessage(query.error)}
          </p>

          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No qualifying cashier collection activity was found
          for this reporting period.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">
                Confirmed POS collections
              </p>
              <p className="mt-2 text-xl font-semibold">
                {money(confirmedTotal)}
              </p>
            </div>

            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">
                Processed refund evidence
              </p>
              <p className="mt-2 text-xl font-semibold">
                {money(refundTotal)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cashier</TableHead>
                  <TableHead className="text-right">
                    Confirmed payments
                  </TableHead>
                  <TableHead className="text-right">
                    Collections
                  </TableHead>
                  <TableHead className="text-right">
                    Processed refunds
                  </TableHead>
                  <TableHead className="text-right">
                    Refund amount
                  </TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {rows.map((row, index) => (
                  <TableRow
                    key={row.cashier_profile_id ?? `unknown-${index}`}
                  >
                    <TableCell className="text-xs">
                      {row.cashier_profile_id
                        ? staffNames.data?.[row.cashier_profile_id] ??
                          `Staff ${row.cashier_profile_id.slice(0, 8)}`
                        : "Cashier not recorded"}
                    </TableCell>

                    <TableCell className="text-right">
                      {amount(row.confirmed_payment_count)}
                    </TableCell>

                    <TableCell className="text-right">
                      {money(
                        amount(row.confirmed_collection_amount),
                      )}
                    </TableCell>

                    <TableCell className="text-right">
                      {amount(row.processed_refund_count)}
                    </TableCell>

                    <TableCell className="text-right">
                      {money(
                        amount(row.processed_refund_amount),
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            Refunds are associated with the original payment
            cashier, not necessarily the employee who processed
            the refund. The current report uses refund decision
            timestamps because a dedicated processing timestamp
            is unavailable in this POS refund table.
          </p>

          <p className="text-xs text-muted-foreground">
            Collection and refund figures must not be subtracted
            to produce an official net-revenue figure until
            Finance reconciliation is complete.
          </p>

          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching
              ? "Refreshing..."
              : "Refresh collection evidence"}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

import { useState } from "react";

import {
  SectionCard,
  TableScroll,
} from "@/components/common/DataDisplay";

import { Button } from "@/components/ui/button";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { money } from "@/lib/pos";

import {
  usePosFinanceRoomTransferRegister,
} from "@/lib/pos-data";

const LABELS: Record<string, string> = {
  "structurally-matched": "Structurally matched",
  "partial-payment-review": "Partial payment review",
  "duplicate-posting-risk": "Duplicate posting risk",
  "ambiguous-folio-evidence": "Multiple folio lines",
  "ambiguous-journal-evidence": "Multiple journals",
  "unverified-folio": "Folio evidence unverified",
  "unverified-journal": "Journal evidence unverified",
  "amount-mismatch": "Folio amount mismatch",
  "journal-amount-mismatch": "Journal amount mismatch",
};

export function PosFinanceReconciliationCard({
  from,
  to,
}: {
  from: string;
  to: string;
}) {
  const query = usePosFinanceRoomTransferRegister(from, to);
  const [showAll, setShowAll] = useState(false);

  const rows = query.data ?? [];

  const exceptions = rows.filter(
    (row) =>
      row.reconciliation_status !== "structurally-matched",
  );

  const displayed = showAll ? rows : exceptions;

  return (
    <SectionCard
      title="POS-to-Finance Reconciliation"
      description="Read-only room-transfer accounting evidence. Structural matching does not certify recognized revenue."
    >
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">
          Loading reconciliation evidence...
        </p>
      ) : query.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-destructive">
            Reconciliation evidence is unavailable.
            Verify the database function and reporting permissions.
          </p>

          <p className="text-xs text-muted-foreground">
            Unavailable evidence must not be classified as
            a missing Finance posting.
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
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">
                Transfers reviewed
              </p>
              <p className="text-2xl font-semibold">
                {rows.length}
              </p>
            </div>

            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">
                Structurally matched
              </p>
              <p className="text-2xl font-semibold">
                {rows.length - exceptions.length}
              </p>
            </div>

            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">
                Requires investigation
              </p>
              <p className="text-2xl font-semibold">
                {exceptions.length}
              </p>
            </div>
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll
              ? "Show exceptions only"
              : "Show all transfers"}
          </Button>

          {displayed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {rows.length === 0
                ? "No accessible transfers were returned for this period."
                : "No reconciliation exceptions were returned."}
            </p>
          ) : (
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>POS bill</TableHead>
                    <TableHead>Bill value</TableHead>
                    <TableHead>Previously paid</TableHead>
                    <TableHead>Folio</TableHead>
                    <TableHead>Journal</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {displayed.map((row) => (
                    <TableRow key={row.order_id}>
                      <TableCell>
                        {row.order_number}
                      </TableCell>

                      <TableCell>
                        {money(Number(row.bill_value))}
                      </TableCell>

                      <TableCell>
                        {money(
                          Number(row.room_transfer_paid_total),
                        )}
                      </TableCell>

                      <TableCell className="font-mono text-xs">
                        {row.folio_line_id
                          ? row.folio_line_id.slice(0, 8)
                          : "Unverified"}
                      </TableCell>

                      <TableCell className="font-mono text-xs">
                        {row.journal_id
                          ? row.journal_id.slice(0, 8)
                          : "Unverified"}
                      </TableCell>

                      <TableCell>
                        {LABELS[row.reconciliation_status] ??
                          row.reconciliation_status}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          )}

          <p className="text-xs text-muted-foreground">
            This register covers room-transferred POS
            orders only. It does not yet reconcile every
            direct POS collection or processed refund.
            A room transfer and its guest-folio charge
            must not be counted as separate revenue.
          </p>

          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching
              ? "Refreshing..."
              : "Refresh reconciliation"}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

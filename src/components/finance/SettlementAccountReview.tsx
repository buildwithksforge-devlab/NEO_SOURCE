/**
 * Settlement account review.
 *
 * Lists posted receipts sitting in an account that disagrees with how the money
 * was taken, and offers one controlled correction per receipt. Nothing is
 * corrected automatically and nothing historical is edited: correcting posts a
 * new, dated, balanced entry carrying the reason typed here.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, FinanceQueryState } from "@/components/finance/FinanceShared";
import {
  METHOD_LABEL,
  useReclassifySettlement,
  useSettlementReview,
} from "@/lib/settlement-review";
import { money, shortDate } from "@/lib/finance";

export function SettlementAccountReview({ from }: { from?: string }) {
  const review = useSettlementReview(from);
  const reclassify = useReclassifySettlement();
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const rows = review.data ?? [];
  const outstanding = rows.filter((r) => !r.already_reclassified);

  return (
    <SectionCard
      title="Settlement accounts"
      description="Where the money was taken, against the account it was recorded in. Cash belongs in the cash account, M-Pesa in the M-Pesa account."
      actions={
        outstanding.length > 0 ? (
          <Badge variant="outline" className="border-warning/40 text-warning">
            {outstanding.length} to review
          </Badge>
        ) : null
      }
    >
      <FinanceQueryState
        isLoading={review.isLoading}
        error={review.error}
        isEmpty={rows.length === 0}
        empty={
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" />
            Every recorded receipt sits in the account its payment method points to.
          </div>
        }
      >
        <DataTable
          head={["Entry", "Taken by", "Recorded in", "Should be in", "Amount", ""]}
        >
          {rows.map((r) => (
            <tr key={r.line_id} className="align-top">
              <td className="py-2 pr-4">
                <p className="font-medium text-foreground">{r.journal_number}</p>
                <p className="text-xs text-muted-foreground">
                  {shortDate(r.accounting_date)} · {r.description}
                </p>
              </td>
              <td className="py-2 pr-4">{METHOD_LABEL[r.method] ?? r.method}</td>
              <td className="py-2 pr-4">
                <span className="inline-flex items-center gap-1.5">
                  <AlertTriangle className="size-3.5 text-warning" />
                  {r.current_code} {r.current_account}
                </span>
              </td>
              <td className="py-2 pr-4">
                {r.expected_code} {r.expected_account}
              </td>
              <td className="py-2 pr-4">{money(r.amount)}</td>
              <td className="py-2">
                {r.already_reclassified ? (
                  <Badge variant="outline">Corrected</Badge>
                ) : openLine === r.line_id ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={reason}
                      autoFocus
                      placeholder="Why is this being moved?"
                      onChange={(e) => setReason(e.target.value)}
                      className="h-8 w-56"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={reason.trim().length < 4 || reclassify.isPending}
                        onClick={() =>
                          reclassify.mutate(
                            { lineId: r.line_id, reason: reason.trim() },
                            {
                              onSuccess: () => {
                                setOpenLine(null);
                                setReason("");
                              },
                            },
                          )
                        }
                      >
                        {reclassify.isPending ? "Posting…" : "Post correction"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setOpenLine(null);
                          setReason("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpenLine(r.line_id);
                      setReason("");
                    }}
                  >
                    Move to {r.expected_code}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      </FinanceQueryState>
    </SectionCard>
  );
}

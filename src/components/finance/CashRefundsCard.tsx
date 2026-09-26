import { useState } from "react";
import { Undo2 } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FinanceEmpty } from "@/components/finance/FinanceShared";
import { money } from "@/lib/finance";
import { FolioIdentityLine } from "@/components/pms/FolioIdentitySummary";
import {
  useCashRefunds,
  useDecideCashRefund,
  useSettleCashRefund,
} from "@/lib/cash-routing";

/**
 * Cash refunds.
 *
 * A refund is never a free-standing payout: it is raised against the original
 * receipt, cleared automatically only below the configured threshold, approved
 * by someone other than the requester above it, and paid out of a named till so
 * it appears in that session's reconciliation.
 */
export function CashRefundsCard({ branchId }: { branchId?: string | null }) {
  const refunds = useCashRefunds(branchId ?? null);
  const decide = useDecideCashRefund();
  const settle = useSettleCashRefund();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const rows = refunds.data ?? [];

  return (
    <SectionCard
      title="Cash refunds"
      description="Every refund points back at the receipt it reverses. Amounts above the approval threshold cannot be paid out until someone other than the requester authorises them."
    >
      {rows.length === 0 ? (
        <FinanceEmpty
          title="No refunds raised"
          description="Refunds raised against a receipt in the last 90 days appear here with their approval and payout state."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Undo2 className="size-4 text-muted-foreground" aria-hidden />
                  <span className="text-base font-semibold">{money(r.amount)}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    against {r.original_receipt_number ?? "—"}
                  </span>
                  <StatusPill
                    tone={
                      r.status === "settled"
                        ? "success"
                        : r.status === "rejected"
                          ? "destructive"
                          : r.status === "approved"
                            ? "info"
                            : "warning"
                    }
                  >
                    {r.status === "pending_approval"
                      ? "Awaiting approval"
                      : r.status === "approved"
                        ? "Authorised — awaiting payout"
                        : r.status === "settled"
                          ? `Paid out ${r.refund_receipt_number ?? ""}`.trim()
                          : "Rejected"}
                  </StatusPill>
                </div>
                <p className="text-xs text-muted-foreground">
                  {r.reason} · raised by {r.requested_by_name}{" "}
                  {new Date(r.created_at).toLocaleString()}
                  {r.approved_by_name ? ` · decided by ${r.approved_by_name}` : ""}
                  {r.decision_note ? ` · ${r.decision_note}` : ""}
                </p>
                {/* A refund must show the account it repays, never just an amount. */}
                <FolioIdentityLine folioId={r.folio_id} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {r.status === "pending_approval" && !r.mine ? (
                  <>
                    <Input
                      className="h-9 w-44"
                      placeholder="Decision note"
                      value={notes[r.id] ?? ""}
                      onChange={(e) => setNotes((p) => ({ ...p, [r.id]: e.target.value }))}
                    />
                    <Button
                      size="sm"
                      disabled={decide.isPending}
                      onClick={() =>
                        decide.mutate({ refund: r.id, approve: true, note: notes[r.id] ?? "" })
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={(notes[r.id] ?? "").trim().length < 3 || decide.isPending}
                      onClick={() =>
                        decide.mutate({ refund: r.id, approve: false, note: notes[r.id] ?? "" })
                      }
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
                {r.status === "pending_approval" && r.mine ? (
                  <p className="text-xs text-muted-foreground">
                    You raised this refund, so someone else must authorise it.
                  </p>
                ) : null}
                {r.status === "approved" ? (
                  <Button size="sm" disabled={settle.isPending} onClick={() => settle.mutate(r.id)}>
                    Pay out from my till
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

import { useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import {
  FinancialStateBadge,
  OperationalStateBadge,
} from "@/components/finance/FinancialStateBadge";
import {
  financialResolutionAction,
  financialStatusMeaning,
  useFinancialStates,
} from "@/lib/financial-state";
import { QueryState } from "@/components/pms/PmsShared";
import { FormDialog } from "@/components/common/FormDialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { formatMoney } from "@/lib/inventory";
import {
  useRecentGoodsReceipts,
  useRetryReceiptAccrual,
  useReverseGoodsReceipt,
} from "@/lib/procurement-data";

type Row = Record<string, unknown>;

/**
 * Stock value never rises without an accounting explanation.
 *
 * Every posted receipt writes Dr Inventory / Cr Goods Received Not Invoiced.
 * This panel shows that consequence next to the delivery it came from, so
 * Stores and Finance can be traced to each other in either direction, and
 * exposes the controlled reversal for a delivery that should not have been
 * posted.
 */
export function ReceiptFinanceTrail({ symbol }: { symbol: string }) {
  const { can, isAdmin } = useAuth();
  const canReverse = isAdmin || can("procurement", "receiving.manage");
  const receipts = useRecentGoodsReceipts();
  const states = useFinancialStates({ module: "inventory-receipt" });
  const reverse = useReverseGoodsReceipt();
  const retryAccrual = useRetryReceiptAccrual();
  const [target, setTarget] = useState<Row | null>(null);
  const [reason, setReason] = useState("");

  const rows = (receipts.data ?? []) as Row[];
  const stateBySource = new Map((states.data ?? []).map((s) => [s.source_id, s]));

  return (
    <SectionCard
      title="Receipts and their finance consequence"
      description="A delivery has two states at once: what Stores did with it, and what Finance has recorded. They are shown separately, because a receipt is only financially posted when a balanced journal exists."
    >
      <QueryState
        isLoading={receipts.isLoading}
        error={receipts.error}
        isEmpty={rows.length === 0}
        empty={
          <p className="py-6 text-sm text-muted-foreground">
            No deliveries received for this property yet.
          </p>
        }
      >
        <ul className="divide-y divide-border">
          {rows.map((r) => {
            const state = stateBySource.get(String(r["id"])) ?? null;
            const financial = state?.financial_status ?? "pending";
            const reversed = Boolean(r["reversed_at"]);
            return (
              <li key={String(r["id"])} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">
                    {String(r["grn_number"] ?? "Goods receipt")}
                    {(r["purchase_orders"] as Row | null)?.["order_number"]
                      ? ` · ${String((r["purchase_orders"] as Row)["order_number"])}`
                      : " · direct receipt"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {`${(r["suppliers"] as Row | null)?.["name"] ?? "Supplier"} · ${formatMoney(r["total_value"], symbol)}`}
                    {r["received_at"] ? ` · ${String(r["received_at"]).slice(0, 10)}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {state?.reason ?? financialStatusMeaning(financial)}
                  </p>
                  {financialResolutionAction(financial) ? (
                    <p className="text-xs font-medium">Next step: {financialResolutionAction(financial)}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <OperationalStateBadge status={String(r["status"] ?? "")} />
                  <FinancialStateBadge status={financial} />
                  {/* Stock posted but no journal: the finance side can be
                      re-attempted without touching the stock movement. */}
                  {canReverse &&
                  !reversed &&
                  String(r["status"]) === "posted" &&
                  !r["accrual_journal_id"] ? (
                    <Button
                      size="sm"
                      disabled={retryAccrual.isPending}
                      onClick={() => retryAccrual.mutate({ receiptId: String(r["id"]) })}
                    >
                      Post to finance
                    </Button>
                  ) : null}
                  {canReverse && !reversed && String(r["status"]) === "posted" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setTarget(r);
                        setReason("");
                      }}
                    >
                      Reverse
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </QueryState>


      <FormDialog
        open={Boolean(target)}
        onOpenChange={(v) => {
          if (!v) setTarget(null);
        }}
        title={`Reverse ${String(target?.["grn_number"] ?? "receipt")}`}
        description="Stock is taken back out, the accrual is reversed and the purchase order quantities are corrected. Nothing is deleted — the reversal is recorded against the original receipt."
        submitLabel="Reverse receipt"
        busyLabel="Reversing…"
        canSubmit={reason.trim().length > 3}
        busy={reverse.isPending}
        onSubmit={() =>
          target
            ? reverse.mutate(
                { receiptId: String(target["id"]), reason: reason.trim() },
                { onSuccess: () => setTarget(null) },
              )
            : undefined
        }
        size="md"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="grn-reverse-reason">Reason</Label>
          <Textarea
            id="grn-reverse-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this delivery being reversed?"
          />
        </div>
      </FormDialog>
    </SectionCard>
  );
}

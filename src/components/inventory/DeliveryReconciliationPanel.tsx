/**
 * Live reconciliation of a delivery being counted in, against the purchase
 * order and the stock ledger, shown before the receipt can be posted.
 */
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatQuantity } from "@/lib/inventory";
import {
  varianceLabel,
  varianceTone,
  type DeliveryReconciliation,
} from "@/lib/delivery-reconciliation";

type Props = {
  reconciliation: DeliveryReconciliation;
  ledgerReady: boolean;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
};

export function DeliveryReconciliationPanel({
  reconciliation,
  ledgerReady,
  acknowledged,
  onAcknowledgedChange,
}: Props) {
  const { lines, shortages, overages, rejections, hasExceptions, deliveredLines } = reconciliation;
  const counted = lines.filter((l) => l.status !== "not-delivered");

  return (
    <SectionCard
      title="Delivery reconciliation"
      description="Every counted line is checked against the outstanding order quantity and against what the stock ledger holds in the receiving store."
      actions={
        <StatusPill tone={deliveredLines === 0 ? "default" : hasExceptions ? "warning" : "success"}>
          {deliveredLines === 0 ? (
            "Nothing counted yet"
          ) : hasExceptions ? (
            <>
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              {shortages.length + overages.length + rejections.length} exception
              {shortages.length + overages.length + rejections.length === 1 ? "" : "s"}
            </>
          ) : (
            <>
              <CheckCircle2 className="mr-1 inline h-3 w-3" />
              Reconciled
            </>
          )}
        </StatusPill>
      }
    >
      {counted.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          Enter what physically arrived above and the comparison appears here.
        </p>
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-border">
            {counted.map((line) => (
              <li
                key={line.lineId}
                className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{line.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {`Outstanding ${formatQuantity(line.outstanding, line.unit)} · delivered ${formatQuantity(line.delivered, line.unit)}`}
                    {line.rejected > 0 ? ` · rejected ${formatQuantity(line.rejected, line.unit)}` : ""}
                    {line.variance !== 0
                      ? ` · variance ${line.variance > 0 ? "+" : ""}${formatQuantity(line.variance, line.unit)}`
                      : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {!ledgerReady || line.ledgerBefore === null
                      ? "Ledger balance unavailable for this line until a receiving store is chosen."
                      : `Ledger in this store: ${formatQuantity(line.ledgerBefore, line.unit)} → ${formatQuantity(line.ledgerAfter ?? 0, line.unit)} once posted`}
                  </p>
                </div>
                <StatusPill tone={varianceTone(line.status)}>{varianceLabel(line.status)}</StatusPill>
              </li>
            ))}
          </ul>

          {hasExceptions ? (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
              <p className="text-sm font-medium">This delivery does not match the order</p>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {shortages.length > 0 ? (
                  <li>
                    {shortages.length} short line{shortages.length === 1 ? "" : "s"} — the balance
                    stays outstanding on the order.
                  </li>
                ) : null}
                {overages.length > 0 ? (
                  <li>
                    {overages.length} over-delivered line{overages.length === 1 ? "" : "s"} — a
                    written reason and over-receipt authority are required.
                  </li>
                ) : null}
                {rejections.length > 0 ? (
                  <li>
                    {rejections.length} line{rejections.length === 1 ? "" : "s"} partly rejected —
                    only the accepted quantity reaches stock.
                  </li>
                ) : null}
              </ul>
              <div className="flex items-start gap-2 pt-1">
                <Checkbox
                  id="grn-ack-variance"
                  checked={acknowledged}
                  onCheckedChange={(v) => onAcknowledgedChange(v === true)}
                />
                <Label htmlFor="grn-ack-variance" className="text-xs font-normal leading-relaxed">
                  I have checked these differences against the goods on the bay and confirm the
                  counts above are what arrived.
                </Label>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Counted quantities agree with the outstanding order. Posting will move the ledger by
              the accepted quantities shown.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/**
 * The supplier payment conveyor control.
 *
 * Scheduling a payment is not paying it. A payment travels
 * Scheduled → Awaiting approval → Approved → Released → Paid, and only the
 * settle step writes the journal. The database owns the rulebook, the
 * self-approval bar and the posting identity, so a repeated click cannot pay a
 * supplier twice. This control only offers the one lawful next step.
 */
import { Button } from "@/components/ui/button";
import type { SupplierPaymentAction } from "@/lib/finance-data";

export function PaymentConveyor({
  status,
  pending,
  onAdvance,
}: {
  status: string;
  pending: boolean;
  onAdvance: (action: SupplierPaymentAction, reason?: string) => void;
}) {
  const next: { action: SupplierPaymentAction; label: string } | null =
    status === "scheduled" || status === "draft" || status === "pending"
      ? { action: "submit", label: "Send for approval" }
      : status === "awaiting-approval"
        ? { action: "approve", label: "Approve" }
        : status === "approved"
          ? { action: "release", label: "Release" }
          : status === "released"
            ? { action: "settle", label: "Confirm paid" }
            : status === "failed"
              ? { action: "submit", label: "Send for approval again" }
              : null;

  if (!next) return <span className="text-xs text-muted-foreground">Complete</span>;
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" disabled={pending} onClick={() => onAdvance(next.action)}>
        {next.label}
      </Button>
      {status === "released" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            const reason = window.prompt("Why did this payment fail?")?.trim();
            if (reason) onAdvance("fail", reason);
          }}
        >
          Failed
        </Button>
      ) : null}
    </div>
  );
}

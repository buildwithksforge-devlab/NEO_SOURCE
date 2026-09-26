import { useState } from "react";
import { HandCoins } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FinanceEmpty } from "@/components/finance/FinanceShared";
import { money } from "@/lib/finance";
import {
  useCancelCashRequest,
  useConfirmCashReceipt,
  useMyCashRequests,
} from "@/lib/cash-routing";

/**
 * Cash awaiting physical receipt at this cashier's till.
 *
 * Confirmation is not an approval: it is the cashier stating the notes are in
 * the drawer. The database settles the folio, issues the receipt, attributes
 * the cash to this session and writes the audit entry atomically.
 */
export function CashRequestInbox() {
  const requests = useMyCashRequests();
  const confirm = useConfirmCashReceipt();
  const cancel = useCancelCashRequest();
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const rows = requests.data ?? [];

  return (
    <SectionCard
      title="Cash awaiting your confirmation"
      description="Billing raised these amounts against your till. Confirm only what you have physically counted into the drawer."
    >
      {rows.length === 0 ? (
        <FinanceEmpty
          title="No cash awaiting confirmation"
          description="Requests routed to your till appear here the moment a colleague sends one."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <HandCoins className="size-4 text-muted-foreground" aria-hidden />
                  <span className="text-base font-semibold">{money(r.amount)}</span>
                  <StatusPill tone="warning">Awaiting cash</StatusPill>
                </div>
                <p className="text-xs text-muted-foreground">
                  Requested {new Date(r.created_at).toLocaleString()}
                  {r.reference ? ` · Ref ${r.reference}` : ""}
                  {r.notes ? ` · ${r.notes}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="h-9 w-44"
                  placeholder="Reason to decline"
                  value={reasons[r.id] ?? ""}
                  onChange={(e) => setReasons((p) => ({ ...p, [r.id]: e.target.value }))}
                  aria-label="Reason to decline this cash request"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(reasons[r.id] ?? "").trim().length < 3 || cancel.isPending}
                  onClick={() =>
                    cancel.mutate({ request: r.id, reason: (reasons[r.id] ?? "").trim() })
                  }
                >
                  Decline
                </Button>
                <Button size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate(r.id)}>
                  Confirm cash received
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

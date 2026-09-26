import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FinanceEmpty } from "@/components/finance/FinanceShared";
import { money } from "@/lib/finance";
import {
  useCancelCashTransfer,
  useCashTransfers,
  useConfirmCashTransfer,
  useSendCashTransfer,
  useTillContext,
} from "@/lib/cash-routing";

/**
 * Controlled transfers between tills.
 *
 * Cash leaves the sending drawer the moment it is sent, but only counts in the
 * receiving drawer once that cashier confirms the notes physically arrived.
 * Every transfer carries its own reference, so a variance can always be traced
 * to a named handover rather than an unexplained difference.
 */
export function CashTransfersCard({ branchId }: { branchId?: string | null }) {
  const context = useTillContext(branchId ?? null);
  const transfers = useCashTransfers(branchId ?? null);
  const send = useSendCashTransfer();
  const confirm = useConfirmCashTransfer();
  const cancel = useCancelCashTransfer();

  const myShift = context.data?.my_shift_id ?? null;
  const others = (context.data?.active_tills ?? []).filter((t) => t.shift_id !== myShift);

  const [destination, setDestination] = useState("till");
  const [toShift, setToShift] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const rows = transfers.data ?? [];
  const blocked =
    !myShift ||
    Number(amount) <= 0 ||
    (destination === "till" && toShift === "") ||
    send.isPending;

  return (
    <SectionCard
      title="Cash transfers"
      description="Hand cash to another till, the safe or banking with a transfer reference. It is only counted at the other end once the receiving cashier confirms it."
    >
      <div className="grid gap-3 sm:grid-cols-5 sm:items-end">
        <div className="grid gap-1.5">
          <Label>Destination</Label>
          <Select value={destination} onValueChange={setDestination}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="till">Another till</SelectItem>
              <SelectItem value="safe">Safe</SelectItem>
              <SelectItem value="bank">Banking</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {destination === "till" ? (
          <div className="grid gap-1.5">
            <Label>Receiving till</Label>
            <Select value={toShift} onValueChange={setToShift}>
              <SelectTrigger>
                <SelectValue placeholder={others.length ? "Choose a till" : "No other open till"} />
              </SelectTrigger>
              <SelectContent>
                {others.map((t) => (
                  <SelectItem key={t.shift_id} value={t.shift_id}>
                    {t.cashier_name}
                    {t.shift_number ? ` · ${t.shift_number}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="transfer-amount">Amount</Label>
          <Input
            id="transfer-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="transfer-notes">Notes</Label>
          <Input
            id="transfer-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <Button
          disabled={blocked}
          onClick={() =>
            send.mutate(
              {
                amount: Number(amount),
                destination,
                toShift: destination === "till" ? toShift : null,
                notes,
              },
              {
                onSuccess: () => {
                  setAmount("");
                  setNotes("");
                  setToShift("");
                },
              },
            )
          }
        >
          Send cash
        </Button>
      </div>
      {!myShift ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Open your own till before sending cash — a transfer always leaves a named drawer.
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {rows.length === 0 ? (
          <FinanceEmpty
            title="No transfers in the last 30 days"
            description="Handovers between tills, to the safe and to banking appear here with their reference."
          />
        ) : (
          rows.map((t) => (
            <div
              key={t.id}
              className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <ArrowLeftRight className="size-4 text-muted-foreground" aria-hidden />
                  <span className="text-base font-semibold">{money(t.amount)}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {t.transfer_number}
                  </span>
                  <StatusPill
                    tone={
                      t.status === "received"
                        ? "success"
                        : t.status === "cancelled"
                          ? "default"
                          : "warning"
                    }
                  >
                    {t.status === "in_transit"
                      ? "Awaiting confirmation"
                      : t.status === "received"
                        ? "Received"
                        : "Cancelled"}
                  </StatusPill>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t.sent_by_name} → {t.destination === "till" ? t.to_cashier_name : t.destination}
                  {t.sent_at ? ` · sent ${new Date(t.sent_at).toLocaleString()}` : ""}
                  {t.received_at ? ` · received ${new Date(t.received_at).toLocaleString()}` : ""}
                  {t.cancelled_reason ? ` · ${t.cancelled_reason}` : ""}
                </p>
              </div>
              {t.status === "in_transit" ? (
                <div className="flex flex-wrap items-center gap-2">
                  {t.mine_to_confirm ? (
                    <Button
                      size="sm"
                      disabled={confirm.isPending}
                      onClick={() => confirm.mutate(t.id)}
                    >
                      Confirm cash received
                    </Button>
                  ) : null}
                  <Input
                    className="h-9 w-44"
                    placeholder="Cancellation reason"
                    value={reasons[t.id] ?? ""}
                    onChange={(e) => setReasons((p) => ({ ...p, [t.id]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={(reasons[t.id] ?? "").trim().length < 3 || cancel.isPending}
                    onClick={() =>
                      cancel.mutate({ transfer: t.id, reason: (reasons[t.id] ?? "").trim() })
                    }
                  >
                    Cancel
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </SectionCard>
  );
}

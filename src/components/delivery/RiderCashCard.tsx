/**
 * Rider cash — what riders declared after collecting cash on delivery, and the
 * cashier-side count that closes it. A rider can never count their own cash;
 * the database refuses it and the screen states the reason returned.
 */
import { useState } from "react";
import { Banknote } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { money, shortDateTime, titleCase } from "@/lib/delivery";
import { useCashRemittances, useReconcileRemittance } from "@/lib/delivery-data";
import { useMyOpenShift } from "@/lib/pos-data";

type Row = Record<string, unknown>;

const TONE: Record<string, "default" | "success" | "warning" | "destructive"> = {
  submitted: "warning",
  received: "warning",
  reconciled: "success",
  disputed: "destructive",
};

export function RiderCashCard() {
  const { can } = useAuth();
  const mayReconcile = can("delivery", "payments.reconcile");
  const remittances = useCashRemittances();
  const reconcile = useReconcileRemittance();
  const myShift = useMyOpenShift();
  const [target, setTarget] = useState<Row | null>(null);
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [intoTill, setIntoTill] = useState(true);

  const rows = (remittances.data ?? []) as Row[];
  const open = rows.filter((r) => String(r["status"]) !== "reconciled");
  const expected = Number(target?.["expected_amount"] ?? 0);
  const variance = counted === "" ? 0 : Number(counted) - expected;
  const shift = (myShift.data ?? null) as Row | null;
  const shiftId = shift ? String(shift["id"]) : undefined;

  return (
    <SectionCard
      title="Rider cash"
      description="Cash collected on delivery, declared by the rider and counted by the cashier. Any difference is recorded with a reason."
      actions={<StatusPill tone={open.length ? "warning" : "success"}>{open.length} awaiting count</StatusPill>}
    >
      <QueryState
        isLoading={remittances.isLoading}
        error={remittances.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No rider cash submitted"
            description="Amounts appear here once a rider hands cash in for counting."
            icon={Banknote}
          />
        }
      >
        <ul className="divide-y divide-border/60">
          {rows.slice(0, 25).map((r) => {
            const rider = (r["rider_profiles"] ?? {}) as Row;
            const status = String(r["status"] ?? "submitted");
            return (
              <li key={String(r["id"])} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {String(r["reference"] ?? "Remittance")}{" "}
                    <span className="text-muted-foreground">· {String(rider["display_name"] ?? "Rider")}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Declared {money(Number(r["declared_amount"] ?? 0))} · expected{" "}
                    {money(Number(r["expected_amount"] ?? 0))}
                    {r["counted_amount"] === null || r["counted_amount"] === undefined
                      ? ""
                      : ` · counted ${money(Number(r["counted_amount"]))}`}{" "}
                    · {shortDateTime(String(r["submitted_at"] ?? r["created_at"] ?? ""))}
                  </p>
                </div>
                <StatusPill tone={TONE[status] ?? "default"}>{titleCase(status)}</StatusPill>
                {mayReconcile && status !== "reconciled" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setTarget(r);
                      setCounted(String(r["declared_amount"] ?? ""));
                      setReason("");
                    }}
                  >
                    Count cash
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </QueryState>

      <Dialog open={Boolean(target)} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Count {String(target?.["reference"] ?? "rider cash")}</DialogTitle>
            <DialogDescription>
              Enter the amount actually counted. A difference from the expected amount needs a reason, and the count is
              recorded against your name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="counted-cash">Amount counted</Label>
              <Input
                id="counted-cash"
                inputMode="decimal"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Expected {money(expected)} · difference {money(variance)}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="counted-reason">Reason for a difference</Label>
              <Textarea
                id="counted-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Only needed when the counted amount differs"
              />
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3">
              <div className="min-w-0">
                <Label htmlFor="into-till" className="text-sm">
                  Take into my till
                </Label>
                <p className="text-xs text-muted-foreground">
                  {shiftId
                    ? "The counted amount is added to your open till, so your shift count and the day's figures include it."
                    : "You have no open till. Open one on the cash queue to take this money in, or count it now and bank it separately."}
                </p>
              </div>
              <Switch
                id="into-till"
                checked={Boolean(shiftId) && intoTill}
                disabled={!shiftId}
                onCheckedChange={setIntoTill}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={counted === "" || Number.isNaN(Number(counted)) || reconcile.isPending || (variance !== 0 && !reason.trim())}
              onClick={() =>
                reconcile.mutate(
                  {
                    id: String(target?.["id"]),
                    counted: Number(counted),
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                    ...(shiftId && intoTill ? { shiftId } : {}),
                  },
                  { onSuccess: () => setTarget(null) },
                )
              }
            >
              Record the count
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

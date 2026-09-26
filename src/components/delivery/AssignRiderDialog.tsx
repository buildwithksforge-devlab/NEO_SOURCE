/**
 * Assignment dialog for one delivery order. Eligibility is resolved entirely in
 * the database — this screen only displays who may take the order and, for every
 * rider who may not, the reason. Reassignment requires a written reason.
 */
import { useState } from "react";
import { Bike } from "lucide-react";
import { QueryState } from "@/components/operations/OpsShared";
import { StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { shortDateTime, titleCase } from "@/lib/delivery";
import { useAssignRider, useDispatchCandidates, type DispatchCandidate } from "@/lib/delivery-data";
import { RpcAccessNotice } from "@/components/common/RpcAccessNotice";
import { requiresReauthentication } from "@/lib/rpc-telemetry";

type Props = {
  orderId: string | null;
  orderNumber?: string | null;
  currentRiderId?: string | null;
  onOpenChange: (open: boolean) => void;
};

export function AssignRiderDialog({ orderId, orderNumber, currentRiderId, onOpenChange }: Props) {
  const candidates = useDispatchCandidates(orderId);
  const assign = useAssignRider();
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const reassigning = Boolean(currentRiderId);
  const rows = candidates.data ?? [];
  const eligible = rows.filter((r) => r.eligible);
  const blocked = rows.filter((r) => !r.eligible);

  const submit = () => {
    if (!orderId || !selected) return;
    assign.mutate(
      { orderId, riderId: selected, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          setSelected(null);
          setReason("");
          onOpenChange(false);
        },
      },
    );
  };

  const row = (r: DispatchCandidate) => (
    <button
      key={r.rider_id}
      type="button"
      disabled={!r.eligible}
      onClick={() => setSelected(r.rider_id)}
      className={`w-full rounded-lg border p-3 text-left transition ${
        selected === r.rider_id ? "border-primary bg-primary/10" : "border-border/60 bg-card/40"
      } ${r.eligible ? "hover:border-primary/60" : "opacity-70"}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">
            <Bike className="mr-1 inline h-3.5 w-3.5" />
            {r.display_name ?? "Rider"}
            {r.rider_id === currentRiderId ? " · current" : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {r.rider_code ?? "—"} · {titleCase(r.vehicle_type ?? "unspecified")} · {r.active_load}/{r.max_active} active
            · {r.delivered_today} delivered today
            {r.next_shift && !r.on_shift ? ` · next shift ${shortDateTime(r.next_shift)}` : ""}
          </p>
        </div>
        <StatusPill tone={r.eligible ? "success" : "warning"}>{r.eligible ? "Available" : "Unavailable"}</StatusPill>
      </div>
      {r.reasons.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {r.reasons.map((reasonText) => (
            <li key={reasonText}>{reasonText}</li>
          ))}
        </ul>
      ) : null}
    </button>
  );

  return (
    <Dialog open={Boolean(orderId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{reassigning ? "Reassign" : "Assign"} {orderNumber ?? "order"}</DialogTitle>
          <DialogDescription>
            Eligibility is decided by the operating system: shift cover, availability, active load, property and cash
            clearance. Riders who cannot take this order show the reason.
          </DialogDescription>
        </DialogHeader>

        {requiresReauthentication(candidates.error) ? (
          <RpcAccessNotice
            context="The rider list"
            onRetry={() => void candidates.refetch()}
            retrying={candidates.isFetching}
          />
        ) : (
        <QueryState
          isLoading={candidates.isLoading}
          error={candidates.error}
          isEmpty={rows.length === 0}
          empty={<p className="text-sm text-muted-foreground">No riders are enrolled for this property.</p>}
        >
          <div className="space-y-2">
            {eligible.map(row)}
            {blocked.length > 0 ? (
              <p className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Cannot take this order
              </p>
            ) : null}
            {blocked.map(row)}
          </div>
        </QueryState>
        )}

        <div className="space-y-2">
          <Label htmlFor="assign-reason">
            Reason {reassigning ? "(required for reassignment)" : "(optional)"}
          </Label>
          <Textarea
            id="assign-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this order moving to a different rider?"
            rows={2}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected || assign.isPending || (reassigning && !reason.trim())}
            onClick={submit}
          >
            {reassigning ? "Reassign rider" : "Assign rider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

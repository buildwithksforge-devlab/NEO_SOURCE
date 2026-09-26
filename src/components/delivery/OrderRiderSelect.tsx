import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDispatchCandidates } from "@/lib/delivery-data";
import { requiresReauthentication } from "@/lib/rpc-telemetry";

/**
 * Rider picker for one order. Candidate discovery is server-side only: the list
 * comes from `neo_delivery_dispatch_candidates`, which resolves eligibility and
 * property scope in the database. Nothing is filtered client-side, so a rider
 * outside the caller's scope is never fetched in the first place.
 */
export function OrderRiderSelect({
  orderId,
  riderId,
  disabled,
  onAssign,
}: {
  orderId: string;
  riderId?: string | null;
  disabled?: boolean;
  onAssign: (riderId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const candidates = useDispatchCandidates(open ? orderId : null);
  const rows = candidates.data ?? [];

  return (
    <Select
      open={open}
      onOpenChange={setOpen}
      value={riderId ? String(riderId) : ""}
      onValueChange={(v) => v && onAssign(v)}
      disabled={disabled ?? false}
    >
      <SelectTrigger className="h-9 w-52">
        <SelectValue placeholder="Assign rider" />
      </SelectTrigger>
      <SelectContent>
        {candidates.isLoading ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">Checking rider eligibility…</div>
        ) : requiresReauthentication(candidates.error) ? (
          <div role="alert" className="space-y-2 px-2 py-3 text-xs text-muted-foreground">
            <p>Your session is no longer authorised, so rider eligibility could not be checked.</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={candidates.isFetching}
              onClick={() => void candidates.refetch()}
            >
              {candidates.isFetching ? "Retrying…" : "Try again"}
            </Button>
          </div>
        ) : candidates.isError ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            You do not have dispatch authority for this order.
          </div>
        ) : rows.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">No riders in scope for this property.</div>
        ) : (
          rows.map((c) => (
            <SelectItem key={c.rider_id} value={c.rider_id} disabled={!c.eligible}>
              <span className="flex flex-col">
                <span>{c.display_name ?? "Rider"}</span>
                <span className="text-xs text-muted-foreground">
                  {c.eligible
                    ? `Available · ${c.active_load}/${c.max_active} active`
                    : (c.reasons[0] ?? "Not eligible")}
                </span>
              </span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

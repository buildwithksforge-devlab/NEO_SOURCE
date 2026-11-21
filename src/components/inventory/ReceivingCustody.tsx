import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SectionCard } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { guardedRpc } from "@/lib/rpc-guard";
import { invalidateSupplyViews } from "@/lib/supply-view-refresh";

type CustodyLine = { line_id: string; item_name: string | null; unit: string };
type CustodyCount = {
  count_id: string;
  branch_id: string;
  order_number: string;
  delivery_note: string;
  lines: CustodyLine[];
  recount_required?: boolean;
};

export function ReceivingCustody() {
  const { organizationId, user, permissionsLoaded } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ["procurement", "receiving-custody", organizationId, user?.id, filterKey],
    enabled: Boolean(organizationId && user && permissionsLoaded),
    queryFn: async () => {
      const { data, error } = await guardedRpc<CustodyCount[]>(
        supabase, "neo_receiving_custody_queue", {},
      );
      if (error) throw new Error(error.message);
      return data;
    },
  });

  const counts = (queue.data ?? []).filter((count) => !branchId || count.branch_id === branchId);
  return (
    <SectionCard title="Storekeeper custody"
      description="Confirm that Stores took custody. Enter an independent count when a reviewer requests one.">
      <div className="space-y-4">
        {queue.isError ? (
          <div className="space-y-3">
            <p role="alert">Storekeeper custody queue could not be loaded. {queue.error.message}</p>
            <Button variant="outline" onClick={() => void queue.refetch()}>Retry</Button>
          </div>
        ) : queue.isPending ? <p role="status">Loading custody queue…</p>
          : counts.length === 0 ? <p className="text-sm text-muted-foreground">No deliveries are waiting for custody confirmation or a requested recount at this property.</p>
          : counts.map((count) => (
          <CustodyForm key={count.count_id} count={count}
            onAccepted={() => invalidateSupplyViews(queryClient)} />
        ))}
      </div>
    </SectionCard>
  );
}

function CustodyForm({ count, onAccepted }: {
  count: CustodyCount;
  onAccepted: () => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const requiresCount = count.recount_required !== false;
  const countLabel = count.recount_required === true ? "recount" : "count";
  const accept = useMutation({
    mutationFn: async (fields: FormData | null) => {
      const lines = fields ? count.lines.map(({ line_id }) => ({
        line_id,
        delivered: fields.get(line_id + "-delivered"),
        rejected: fields.get(line_id + "-rejected"),
        batch: fields.get(line_id + "-batch"),
        expiry: fields.get(line_id + "-expiry") || null,
      })) : [];
      const { data, error } = await guardedRpc<boolean>(supabase, "neo_accept_receiving_custody", {
        _count_id: count.count_id,
        _lines: lines,
      });
      if (error || data !== true) throw new Error(error?.message ?? "Custody was not recorded.");
    },
    onSuccess: async () => {
      toast.success(requiresCount ? `Independent ${countLabel} and custody recorded.` : "Custody confirmed.");
      await onAccepted();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>LPO {count.order_number} · Delivery note {count.delivery_note}</p>
        {requiresCount ? (
          <Button type="button" variant="outline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? `Close ${countLabel}` : count.recount_required ? "Record requested recount" : "Record independent count"}
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled={accept.isPending} onClick={() => accept.mutate(null)}>
            Confirm custody
          </Button>
        )}
      </div>
      {requiresCount && expanded && (
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          accept.mutate(new FormData(event.currentTarget));
        }}>
          {count.lines.map((line) => (
            <fieldset key={line.line_id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-4">
              <legend>{line.item_name ?? "Purchase item"} ({line.unit})</legend>
              <label>Delivered<Input required type="number" min="0" step="any" name={line.line_id + "-delivered"} /></label>
              <label>Rejected<Input required type="number" min="0" step="any" name={line.line_id + "-rejected"} /></label>
              <label>Batch<Input name={line.line_id + "-batch"} /></label>
              <CustodyExpiry name={line.line_id + "-expiry"} />
            </fieldset>
          ))}
          <Button type="submit" disabled={accept.isPending}>Submit {countLabel} and confirm custody</Button>
        </form>
      )}
    </div>
  );
}

function CustodyExpiry({ name }: { name: string }) {
  const [date, setDate] = useState("");
  return (
    <div>
      <label htmlFor={name}>Expiry</label>
      <NeoDatePicker id={name} value={date} onChange={setDate} />
      <input type="hidden" name={name} value={date} />
    </div>
  );
}

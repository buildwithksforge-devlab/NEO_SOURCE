import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SectionCard } from "@/components/common/DataDisplay";
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

  if (queue.isError) {
    return <p role="alert">Storekeeper custody queue could not be loaded. {queue.error.message}</p>;
  }

  const counts = (queue.data ?? []).filter((count) => !branchId || count.branch_id === branchId);
  if (counts.length === 0) return null;
  return (
    <SectionCard title="Storekeeper count and custody"
      description="Count the delivery independently. Record the quantities physically received and rejected, plus batch and expiry where applicable.">
      <div className="space-y-4">
        {counts.map((count) => (
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
  const accept = useMutation({
    mutationFn: async (fields: FormData) => {
      const lines = count.lines.map(({ line_id }) => ({
        line_id,
        delivered: fields.get(line_id + "-delivered"),
        rejected: fields.get(line_id + "-rejected"),
        batch: fields.get(line_id + "-batch"),
        expiry: fields.get(line_id + "-expiry") || null,
      }));
      const { data, error } = await guardedRpc<boolean>(supabase, "neo_accept_receiving_custody", {
        _count_id: count.count_id,
        _lines: lines,
      });
      if (error || data !== true) throw new Error(error?.message ?? "Custody was not recorded.");
    },
    onSuccess: async () => {
      toast.success("Storekeeper count and custody recorded.");
      await onAccepted();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>LPO {count.order_number} · Delivery note {count.delivery_note}</p>
        <Button type="button" variant="outline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Close count" : "Record independent count"}
        </Button>
      </div>
      {expanded && (
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
              <label>Expiry<Input type="date" name={line.line_id + "-expiry"} /></label>
            </fieldset>
          ))}
          <Button type="submit" disabled={accept.isPending}>Record count and accept custody</Button>
        </form>
      )}
    </div>
  );
}

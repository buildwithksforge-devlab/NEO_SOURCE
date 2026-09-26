import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  eligibleTickets,
  TICKET_ACTION_LABELS,
  useKitchenBulkTicketTransition,
  type KitchenTicket,
} from "@/lib/kitchen-tickets";

/** Bulk actions chefs and managers actually use on a busy pass. */
const BULK_TARGETS = ["accepted", "preparing", "ready", "served"] as const;

export function BulkTicketBar({
  tickets,
  selected,
  onSelectedChange,
}: {
  tickets: KitchenTicket[];
  selected: string[];
  onSelectedChange: (next: string[]) => void;
}) {
  const bulk = useKitchenBulkTicketTransition();
  const chosen = tickets.filter((t) => selected.includes(t.ticket_id));
  const allSelected = tickets.length > 0 && chosen.length === tickets.length;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={allSelected}
          onCheckedChange={(v) => onSelectedChange(v === true ? tickets.map((t) => t.ticket_id) : [])}
          aria-label="Select all visible tickets"
        />
        Select all visible
      </label>
      <span className="text-sm text-muted-foreground">{chosen.length} selected</span>

      <div className="ml-auto flex flex-wrap gap-2">
        {BULK_TARGETS.map((to) => {
          const eligible = eligibleTickets(chosen, to);
          return (
            <Button
              key={to}
              size="sm"
              variant={to === "accepted" ? "default" : "outline"}
              disabled={bulk.isPending || eligible.length === 0}
              onClick={() =>
                bulk.mutate(
                  { ticketIds: eligible.map((t) => t.ticket_id), to },
                  { onSuccess: () => onSelectedChange([]) },
                )
              }
            >
              {TICKET_ACTION_LABELS[to] ?? to} ({eligible.length})
            </Button>
          );
        })}
      </div>
      <p className="w-full text-xs text-muted-foreground">
        Only tickets that can legally take the move are sent. Each ticket is applied on its own — one refusal never
        undoes the rest, and every change is recorded against you.
      </p>
    </div>
  );
}

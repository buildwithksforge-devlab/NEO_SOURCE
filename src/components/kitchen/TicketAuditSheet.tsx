import { StatusPill } from "@/components/common/DataDisplay";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { titleCase } from "@/lib/kitchen";
import { useKitchenTicketAudit, type KitchenTicket } from "@/lib/kitchen-tickets";

/**
 * Per-ticket audit sidebar: every recorded item and ticket status change with
 * actor, timestamp and any reconciliation reason. Read-only, straight from
 * `neo_kitchen_ticket_audit`.
 */
export function TicketAuditSheet({
  ticket,
  onOpenChange,
}: {
  ticket: KitchenTicket | null;
  onOpenChange: (open: boolean) => void;
}) {
  const audit = useKitchenTicketAudit(ticket?.ticket_id ?? null);
  const events = audit.data ?? [];

  return (
    <Sheet open={Boolean(ticket)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Ticket audit trail</SheetTitle>
          <SheetDescription>
            {ticket
              ? `${ticket.ticket_number} · ${ticket.station_name ?? "Routing not configured"} · currently ${titleCase(ticket.status)}`
              : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          {audit.isLoading ? (
            <>
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </>
          ) : audit.error ? (
            <p className="text-sm text-destructive">{(audit.error as Error).message}</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No status changes have been recorded against this ticket yet.
            </p>
          ) : (
            <ol className="space-y-3">
              {events.map((e) => (
                <li key={e.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {e.from_status ? `${titleCase(e.from_status)} → ` : ""}
                      {titleCase(e.to_status)}
                    </p>
                    <StatusPill tone={e.scope === "ticket" ? "info" : "default"}>
                      {e.scope === "ticket" ? "Ticket" : "Item"}
                    </StatusPill>
                  </div>
                  {e.item_name ? <p className="text-xs text-muted-foreground">{e.item_name}</p> : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {e.actor_name ?? "System"} · {new Date(e.created_at).toLocaleString()}
                  </p>
                  {e.reason ? <p className="mt-1 text-xs">Reason: {e.reason}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

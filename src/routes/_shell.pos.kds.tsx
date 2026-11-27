import { useEffect as useNeoSelectionEffect } from "react";
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChefHat } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, PosGuard, QueryState } from "@/components/pos/PosShared";
import { TicketCard } from "@/components/kitchen/TicketCard";
import { BulkTicketBar } from "@/components/kitchen/BulkTicketBar";
import { TicketAuditSheet } from "@/components/kitchen/TicketAuditSheet";
import {
  useKitchenTicketBackfill,
  useKitchenTicketDelay,
  useKitchenTicketRealtime,
  useKitchenTicketTransition,
  useKitchenTickets,
  useScopedStations,
  useStationAuthority,
  type KitchenTicket,
} from "@/lib/kitchen-tickets";

export const Route = createFileRoute("/_shell/pos/kds")({
  head: () => ({
    meta: [
      { title: "Kitchen Display — NEØ" },
      {
        name: "description",
        content:
          "Live station tickets for hot kitchen, pastry, bar and coffee with prep timers and delay reasons.",
      },
      { property: "og:title", content: "Kitchen Display — NEØ" },
      {
        property: "og:description",
        content:
          "Live station tickets for hot kitchen, pastry, bar and coffee with prep timers and delay reasons.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="kds.view" path="/pos/kds">
      <KdsPage />
    </PosGuard>
  ),
});

function KdsPage() {
  const { stations, allowAll } = useScopedStations();
  const { canWorkStation } = useStationAuthority();
  const [station, setStation] = useState(allowAll ? "all" : "");
  const effectiveStation = station || (allowAll ? "all" : (stations[0]?.id ?? "all"));

  const [combinedStations, setCombinedStations] = useState<string[]>([]);

  const allowedCombinedStations = combinedStations.filter(
    (id) => stations.some((s) => s.id === id),
  );

  const combinedMode =
    allowAll && effectiveStation === "all" &&
    combinedStations.length > 0;

  const [selected, setSelected] = useState<string[]>([]);
  const [auditTicket, setAuditTicket] = useState<KitchenTicket | null>(null);
  useKitchenTicketRealtime();
  const queue = useKitchenTickets(effectiveStation, "live");

  const visibleTickets = combinedMode
    ? queue.tickets.filter(
        (ticket) =>
          ticket.station_id !== null &&
          allowedCombinedStations.includes(ticket.station_id),
      )
    : queue.tickets;

  // neoVisibleSelectionGuard

  const neoVisibleSelectionIds = new Set(
    visibleTickets.map(ticket => ticket.ticket_id)
  );

  const neoSafeSelected = selected.filter(
    id => neoVisibleSelectionIds.has(id)
  );

  useNeoSelectionEffect(() => {

    setSelected(previous => {

      const next = previous.filter(
        id => neoVisibleSelectionIds.has(id)
      );

      return next.length === previous.length
        ? previous
        : next;

    });

  }, [visibleTickets]);

  useNeoSelectionEffect(() => {
    setSelected([]);
  }, [effectiveStation, combinedMode, JSON.stringify(combinedStations)]);



  const transition = useKitchenTicketTransition();
  const delay = useKitchenTicketDelay();
  const backfill = useKitchenTicketBackfill();

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="Kitchen Display System"
        description="The same canonical production tickets the Kitchen Live Queue works from. Updates flow straight back to the waiter."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select value={effectiveStation} onValueChange={(value) => {
              setStation(value);
              setSelected([]);
            }}>
              <SelectTrigger className="w-56" aria-label="Station">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowAll ? <SelectItem value="all">All stations</SelectItem> : null}
                {stations.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              disabled={backfill.isPending}
              onClick={() => backfill.mutate()}
            >
              Reconcile tickets
            </Button>
          </div>
        }
      />


      {allowAll && effectiveStation === "all" && stations.length > 1 && (
        <div className="mb-4 rounded-lg border p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Combined station view</p>
              <p className="text-xs text-muted-foreground">
                Select any combination of production stations.
                No selection displays all authorized stations.
              </p>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCombinedStations([]);
                setSelected([]);
              }}
            >
              Show all stations
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {stations.map((s) => (
              <Button
                key={s.id}
                size="sm"
                variant={
                  allowedCombinedStations.includes(s.id)
                    ? "default"
                    : "outline"
                }
                aria-pressed={allowedCombinedStations.includes(s.id)}
                onClick={() => {
                  setCombinedStations((previous) =>
                    previous.includes(s.id)
                      ? previous.filter((id) => id !== s.id)
                      : [...previous, s.id],
                  );
                  setSelected([]);
                }}
              >
                {s.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      <QueryState
        isLoading={queue.isLoading}
        error={queue.error}
        isEmpty={!queue.isLoading && !queue.error && visibleTickets.length === 0}
        empty={
          <EmptyState
            icon={ChefHat}
            title="No live tickets"
            description="Tickets appear the moment a waiter sends items to this station."
          />
        }
      >
        <BulkTicketBar tickets={visibleTickets} selected={neoSafeSelected} onSelectedChange={setSelected} />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleTickets.map((t) => (
            <TicketCard
              key={t.ticket_id}
              ticket={t}
              pendingTo={
                transition.isPending && transition.variables?.ticketId === t.ticket_id
                  ? transition.variables.to
                  : null
              }
              busy={delay.isPending && delay.variables?.ticketId === t.ticket_id}
              selected={neoSafeSelected.includes(t.ticket_id)}
              onSelectedChange={(next) =>
                setSelected((prev) =>
                  next
                    ? [...new Set([...prev, t.ticket_id])]
                    : prev.filter((id) => id !== t.ticket_id),
                )
              }
              stationAuthority={canWorkStation(t.station_id)}
              onOpenAudit={() => setAuditTicket(t)}
              onTransition={(to, needsReason) => {
                const reason = needsReason ? window.prompt("Reason") : null;
                if (needsReason && !reason?.trim()) return;
                transition.mutate({ ticketId: t.ticket_id, to, ...(reason ? { reason } : {}) });
              }}
              onDelay={() => {
                const reason = window.prompt("Reason for the delay");
                if (reason?.trim()) delay.mutate({ ticketId: t.ticket_id, reason });
              }}
            />
          ))}
        </div>
      </QueryState>

      <TicketAuditSheet
        ticket={auditTicket}
        onOpenChange={(open) => !open && setAuditTicket(null)}
      />
    </div>
  );
}

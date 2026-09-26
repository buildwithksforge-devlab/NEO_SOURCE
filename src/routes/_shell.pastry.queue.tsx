import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { PastryGuard } from "@/components/pastry/PastryShared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/common/StateSystem";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { titleCase } from "@/lib/kitchen";
import {
  ticketActions,
  useKitchenTicketRealtime,
  useKitchenTicketTransition,
  useKitchenTickets,
  useScopedStations,
  type KitchenTicket,
  type QueueView,
} from "@/lib/kitchen-tickets";

export const Route = createFileRoute("/_shell/pastry/queue")({
  head: () => ({
    meta: [
      { title: "Pastry Order Queue — NEØ" },
      {
        name: "description",
        content:
          "Live pastry tickets from restaurant, room service and guest app orders, moved forward on the same canonical ticket record the kitchen and bar use.",
      },
      { property: "og:title", content: "Pastry Order Queue — NEØ" },
      {
        property: "og:description",
        content: "Guest and restaurant pastry orders in one live production queue.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PastryGuard feature="pastry-production">
      <PastryQueuePage />
    </PastryGuard>
  ),
});

const VIEWS: { value: QueueView; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "delayed", label: "Delayed" },
  { value: "all", label: "All" },
];

/** Stations a pastry team legitimately works — matched on the station's own name. */
function isPastryStation(name: string | null | undefined) {
  const n = (name ?? "").toLowerCase();
  return n.includes("pastry") || n.includes("bakery") || n.includes("dessert");
}

function PastryQueuePage() {
  const [view, setView] = useState<QueueView>("live");
  const { stations, isLoading: stationsLoading } = useScopedStations();
  const { tickets, isLoading, error } = useKitchenTickets("all", view);
  const transition = useKitchenTicketTransition();
  useKitchenTicketRealtime();

  const pastryStationIds = useMemo(
    () => new Set(stations.filter((s) => isPastryStation(s.name)).map((s) => s.id)),
    [stations],
  );

  const rows = useMemo(
    () =>
      tickets.filter(
        (t) =>
          (t.station_id && pastryStationIds.has(t.station_id)) || isPastryStation(t.station_name),
      ),
    [tickets, pastryStationIds],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Pastry & Bakery"
        title="Order queue"
        description="Every pastry line a guest or waiter has ordered, on the same ticket record the kitchen display and bar queue use. Moving a ticket here updates the guest's tracker straight away."
      />

      <SectionCard
        title="Pastry tickets"
        description="Filtered to your pastry, bakery and dessert stations at the property you are working in."
        actions={
          <Tabs value={String(view)} onValueChange={(v) => setView(v as QueueView)}>
            <TabsList>
              {VIEWS.map((v) => (
                <TabsTrigger key={String(v.value)} value={String(v.value)}>
                  {v.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      >
        {isLoading || stationsLoading ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ) : error ? (
          <ErrorState error={error} inline />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pastry tickets are waiting. New orders appear here the moment a guest or waiter sends
            them.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((ticket) => (
              <PastryTicketCard
                key={ticket.ticket_id}
                ticket={ticket}
                busy={transition.isPending}
                onMove={(to) => transition.mutate({ ticketId: ticket.ticket_id, to })}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function PastryTicketCard({
  ticket,
  busy,
  onMove,
}: {
  ticket: KitchenTicket;
  busy: boolean;
  onMove: (to: string) => void;
}) {
  const actions = ticketActions(ticket.status).filter((a) => a.to !== "cancelled");
  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{ticket.ticket_number}</p>
          <p className="text-xs text-muted-foreground">
            {ticket.station_name ?? "Station not set"}
            {ticket.order_number ? ` · ${ticket.order_number}` : ""}
          </p>
        </div>
        <StatusPill tone={ticket.is_delayed ? "warning" : "default"}>
          {titleCase(ticket.status)}
        </StatusPill>
      </div>

      <ul className="mt-3 space-y-1 text-sm">
        {(ticket.items ?? []).map((item) => (
          <li key={item.ticket_item_id} className="flex justify-between gap-3">
            <span>
              {item.quantity ?? 1} × {item.item_name ?? "Item"}
            </span>
            <span className="text-xs text-muted-foreground">{titleCase(item.status)}</span>
          </li>
        ))}
      </ul>

      {ticket.allergy_alert ? (
        <p className="mt-2 text-xs font-medium text-destructive">Allergy: {ticket.allergy_alert}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {actions.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing left to do on this ticket.</p>
        ) : (
          actions.map((a) => (
            <Button key={a.to} size="sm" disabled={busy} onClick={() => onMove(a.to)}>
              {a.label}
            </Button>
          ))
        )}
      </div>
    </article>
  );
}

import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChefHat } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { LaneBoard, type Lane } from "@/components/common/LaneBoard";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { TicketCard } from "@/components/kitchen/TicketCard";
import { BulkTicketBar } from "@/components/kitchen/BulkTicketBar";
import { TicketAuditSheet } from "@/components/kitchen/TicketAuditSheet";
import { QUEUE_VIEWS, titleCase } from "@/lib/kitchen";
import {
  useAskClarification,
  useAssignChef,
  useKitchenStaff,
  usePrioritizeTicket,
  useReassignStation,
} from "@/lib/kitchen-data";
import {
  useStationAuthority,
  itemActions,
  KITCHEN_TICKETS_QUERY_KEY,
  TICKET_LIFECYCLE,
  useKitchenItemTransition,
  useKitchenTicketDelay,
  useKitchenTicketRealtime,
  type KitchenTicket,
  useKitchenTicketTransition,
  useKitchenTickets,
  useScopedStations,
} from "@/lib/kitchen-tickets";
import { useAuth } from "@/lib/auth";
import type { Tone } from "@/lib/tone";

export const Route = createFileRoute("/_shell/kitchen/queue")({
  head: () => ({
    meta: [
      { title: "Kitchen Live Queue — NEØ" },
      {
        name: "description",
        content:
          "Station-by-station kitchen display with preparation timers, allergy alerts, chef assignment and item-level production status.",
      },
      { property: "og:title", content: "Kitchen Live Queue — NEØ" },
      {
        property: "og:description",
        content:
          "Station kitchen display with prep timers, allergy alerts and item-level production status.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="queue.view">
      <QueuePage />
    </KitchenGuard>
  ),
});

/** Presentation only — the lifecycle itself comes from TICKET_LIFECYCLE. */
const LANE_TONE: Record<string, Tone> = {
  new: "default",
  accepted: "info",
  preparing: "warning",
  "partially-ready": "warning",
  ready: "success",
  served: "success",
  completed: "success",
};

/** A focus figure narrows the board to a cross-cutting concern, not a status. */
type Focus = "none" | "delayed" | "missing-station" | "rush";

function QueuePage() {
  const qc = useQueryClient();
  const { stations, allowAll } = useScopedStations();
  const [station, setStation] = useState(allowAll ? "all" : "");
  const [view, setView] = useState<string>("live");
  const [focus, setFocus] = useState<Focus>("none");
  const [selected, setSelected] = useState<string[]>([]);
  const [auditTicket, setAuditTicket] = useState<KitchenTicket | null>(null);
  useKitchenTicketRealtime();

  const effectiveStation = station || (allowAll ? "all" : (stations[0]?.id ?? "all"));
  const queue = useKitchenTickets(effectiveStation, view);
  const transition = useKitchenTicketTransition();
  const delay = useKitchenTicketDelay();
  const { canWorkStation } = useStationAuthority();

  const staff = useKitchenStaff();
  const itemTransition = useKitchenItemTransition();
  const prioritize = usePrioritizeTicket();
  const reassign = useReassignStation();
  const assign = useAssignChef();
  const clarify = useAskClarification();
  const { canExact } = useAuth();
  // Allocation is a kitchen-management authority; execution stays open to the
  // chefs working the board.
  const canAllocate =
    canExact("kitchen", "chef.assign") ||
    canExact("kitchen", "item.reassign") ||
    canExact("kitchen", "production.manage");

  const refresh = () => void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });

  const delayedCount = queue.tickets.filter((t) => t.is_delayed).length;
  const missingStationCount = queue.tickets.filter((t) => t.station_missing).length;
  const rushCount = queue.tickets.filter((t) => t.priority && t.priority !== "normal").length;

  const toggleFocus = (next: Focus) => setFocus((prev) => (prev === next ? "none" : next));

  const focused = useMemo(
    () =>
      queue.tickets.filter((t) => {
        if (focus === "delayed") return t.is_delayed;
        if (focus === "missing-station") return t.station_missing;
        if (focus === "rush") return t.priority && t.priority !== "normal";
        return true;
      }),
    [queue.tickets, focus],
  );

  // Lanes mirror the ticket's own lifecycle — no status is invented here.
  const lanes: Lane<KitchenTicket>[] = TICKET_LIFECYCLE.map((status) => ({
    id: status,
    label: titleCase(status),
    tone: LANE_TONE[status] ?? "default",
    items: focused.filter((t) => t.status === status),
  })).filter((lane) => lane.items.length > 0 || view !== "all");

  const leadFigure: SummaryFigure = {
    id: "open",
    label: "Open tickets",
    value: queue.isLoading ? "…" : queue.tickets.length,
    hint: `${QUEUE_VIEWS.find((v) => v.key === view)?.label ?? titleCase(view)} view`,
  };
  const figures: SummaryFigure[] = [
    {
      id: "delayed",
      label: "Delayed",
      value: queue.isLoading ? "…" : delayedCount,
      tone: delayedCount ? "warning" : "success",
      onSelect: () => toggleFocus("delayed"),
      active: focus === "delayed",
    },
    {
      id: "missing-station",
      label: "Missing station",
      value: queue.isLoading ? "…" : missingStationCount,
      hint: "No production routing",
      tone: missingStationCount ? "destructive" : "success",
      onSelect: () => toggleFocus("missing-station"),
      active: focus === "missing-station",
    },
    {
      id: "rush",
      label: "Prioritised",
      value: queue.isLoading ? "…" : rushCount,
      tone: rushCount ? "info" : "default",
      onSelect: () => toggleFocus("rush"),
      active: focus === "rush",
    },
  ];

  const renderTicket = (t: KitchenTicket) => (
    <TicketCard
      key={t.ticket_id}
      ticket={t}
      pendingTo={
        transition.isPending && transition.variables?.ticketId === t.ticket_id
          ? transition.variables.to
          : null
      }
      busy={delay.isPending && delay.variables?.ticketId === t.ticket_id}
      selected={selected.includes(t.ticket_id)}
      onSelectedChange={(next) =>
        setSelected((prev) =>
          next ? [...new Set([...prev, t.ticket_id])] : prev.filter((id) => id !== t.ticket_id),
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
      renderItemActions={(i) => (
        <>
          {itemActions(i.status).map((a) => (
            <Button
              key={a.to}
              size="sm"
              variant={a.needsReason ? "outline" : "default"}
              disabled={itemTransition.isPending && itemTransition.variables?.itemId === i.ticket_item_id}
              onClick={() => {
                const reason = a.needsReason ? window.prompt(`Reason for ${a.label}`) : null;
                if (a.needsReason && !reason?.trim()) return;
                itemTransition.mutate({
                  itemId: i.ticket_item_id,
                  to: a.to,
                  ...(reason ? { reason } : {}),
                });
              }}
            >
              {a.label ?? titleCase(a.to)}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const question = window.prompt("What needs clarifying with the service team?");
              if (question?.trim())
                clarify.mutate({
                  ticketId: t.ticket_id,
                  ticketItemId: i.ticket_item_id,
                  orderItemId: i.order_item_id,
                  question,
                });
            }}
          >
            Ask waiter
          </Button>
        </>
      )}
      footer={
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const reason = window.prompt("Why is this ticket being prioritised?");
              if (!reason?.trim()) return;
              await prioritize.mutateAsync({ ticketId: t.ticket_id, priority: "rush", reason });
              refresh();
            }}
          >
            Prioritise
          </Button>
          {canAllocate ? (
            <Select
              onValueChange={async (chefId) => {
                await assign.mutateAsync({ ticketId: t.ticket_id, chefId, stationId: t.station_id });
                refresh();
              }}
            >
              <SelectTrigger className="h-8 w-40 text-xs" aria-label="Assign chef">
                <SelectValue placeholder="Assign chef" />
              </SelectTrigger>
              <SelectContent>
                {(staff.data ?? []).map((p) => (
                  <SelectItem key={p["id"]} value={p["id"]}>
                    {p["full_name"] ?? "Unnamed"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {canAllocate ? (
            <Select
              onValueChange={async (stationId) => {
                const reason = window.prompt("Reason for moving this ticket to another station");
                if (!reason?.trim()) return;
                await reassign.mutateAsync({ ticketId: t.ticket_id, stationId, reason });
                refresh();
              }}
            >
              <SelectTrigger className="h-8 w-40 text-xs" aria-label="Move station">
                <SelectValue placeholder="Move station" />
              </SelectTrigger>
              <SelectContent>
                {stations.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </>
      }
    />
  );

  return (
    <div>
      <PageHeader
        eyebrow="Kitchen"
        title="Live production queue"
        description="The same canonical tickets the Kitchen Display shows. Every status change is recorded against the chef who made it."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select value={effectiveStation} onValueChange={setStation}>
              <SelectTrigger className="w-52" aria-label="Station">
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
            <Select value={view} onValueChange={setView}>
              <SelectTrigger className="w-52" aria-label="Queue view">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="live">Live (all open)</SelectItem>
                <SelectItem value="delayed">Delayed</SelectItem>
                <SelectItem value="unassigned-station">Missing station</SelectItem>
                {QUEUE_VIEWS.filter((v) => v.key !== "delayed").map((v) => (
                  <SelectItem key={v.key} value={v.key}>
                    {v.label}
                  </SelectItem>
                ))}
                <SelectItem value="all">All (including history)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <QueryState
        isLoading={queue.isLoading}
        error={queue.error}
        isEmpty={!queue.isLoading && !queue.error && queue.tickets.length === 0}
        empty={
          <EmptyState
            icon={ChefHat}
            title="No tickets in this view"
            description="Tickets appear the moment a waiter sends items to a station."
          />
        }
      >
        <BulkTicketBar tickets={focused} selected={selected} onSelectedChange={setSelected} />
        <LaneBoard
          lanes={lanes}
          getKey={(t) => t.ticket_id}
          renderItem={renderTicket}
          emptyLaneLabel="No tickets in this stage"
        />
      </QueryState>

      <TicketAuditSheet
        ticket={auditTicket}
        onOpenChange={(open) => !open && setAuditTicket(null)}
      />
    </div>
  );
}

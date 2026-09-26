import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { BarGuard, EmptyState, QueryState } from "@/components/bar/BarShared";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/pos";
import {
  barNum,
  barStr,
  nextBarStatus,
  useAcceptBarTicket,
  useAdvanceBarTicket,
  useBarAttendants,
  useBarQueue,
  useReassignBarTicket,
  type BarQueueScope,
  type BarQueueView,
  type BarRow,
} from "@/lib/bar";

export const Route = createFileRoute("/_shell/bar/queue")({
  head: () => ({
    meta: [
      { title: "Bar Order Queue — NEØ" },
      {
        name: "description",
        content:
          "Accept, prepare and serve bar orders in sequence. Attendants see and act on their own orders; the Bar Manager sees and reassigns the whole department.",
      },
      { property: "og:title", content: "Bar Order Queue — NEØ" },
      {
        property: "og:description",
        content: "Live bar service queue with per-attendant ownership and manager oversight.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <BarGuard action="queue.view">
      <BarQueuePage />
    </BarGuard>
  ),
});

const VIEWS: { value: BarQueueView; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "new", label: "New" },
  { value: "accepted", label: "Accepted" },
  { value: "preparing", label: "Preparing" },
  { value: "ready", label: "Ready" },
  { value: "delayed", label: "Delayed" },
  { value: "all", label: "All" },
];

function BarQueuePage() {
  const { can, user } = useAuth();
  const [view, setView] = useState<BarQueueView>("live");
  const [scope, setScope] = useState<BarQueueScope>("all");

  const queue = useBarQueue(view, scope);
  const accept = useAcceptBarTicket();
  const advance = useAdvanceBarTicket();
  const reassign = useReassignBarTicket();
  const attendants = useBarAttendants();

  const mayAccept = can("bar", "queue.accept");
  const mayAdvance = can("bar", "queue.update");
  const mayReassign = can("bar", "queue.assign");

  const rows = (queue.data ?? []) as BarRow[];

  return (
    <div>
      <PageHeader
        eyebrow="Bar Department"
        title="Bar Order Queue"
        description="Drinks flow New → Accepted → Preparing → Ready → Served. Once an attendant accepts an order it belongs to them until it is served or a manager reassigns it."
        actions={
          <Select value={scope} onValueChange={(v) => setScope(v as BarQueueScope)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All orders</SelectItem>
              <SelectItem value="mine">My orders</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <Tabs value={view} onValueChange={(v) => setView(v as BarQueueView)} className="mb-4">
        <TabsList>
          {VIEWS.map((v) => (
            <TabsTrigger key={v.value} value={v.value}>
              {v.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <SectionCard title={`${titleCase(view)} orders`}>
        <QueryState
          isLoading={queue.isLoading}
          error={queue.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No orders in this view"
              description="Bar tickets appear the moment a POS order with beverage items is sent to the bar."
            />
          }
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((r) => {
              const id = String(r["ticket_id"]);
              const status = barStr(r["status"], "new");
              const assigned = r["assigned_to"] ? String(r["assigned_to"]) : null;
              const mine = assigned !== null && assigned === (user?.id ?? "");
              const next = nextBarStatus(status);
              const items = (r["items"] ?? []) as Record<string, unknown>[];
              return (
                <div
                  key={id}
                  className={cn(
                    "relative overflow-hidden rounded-xl border bg-card p-4 pl-5 transition-shadow hover:shadow-sm",
                    r["is_delayed"]
                      ? "border-warning/45"
                      : status === "ready"
                        ? "border-success/40"
                        : "border-outline-subtle",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 left-0 w-1.5",
                      r["is_delayed"]
                        ? "bg-warning/80"
                        : status === "ready"
                          ? "bg-success/70"
                          : status === "new"
                            ? "bg-info/70"
                            : "bg-border",
                    )}
                  />
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{barStr(r["ticket_number"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {barStr(r["station_name"], "Bar")} · {barStr(r["table_code"], "No table")} ·{" "}
                        {barNum(r["age_minutes"])} min
                      </p>
                    </div>
                    <StatusPill
                      tone={
                        r["is_delayed"] ? "warning" : status === "ready" ? "success" : "default"
                      }
                    >
                      {titleCase(status)}
                    </StatusPill>
                  </div>

                  <ul className="mt-3 space-y-1 text-sm">
                    {items.length === 0 ? (
                      <li className="text-muted-foreground">No item detail on this ticket</li>
                    ) : (
                      items.map((it, i) => (
                        <li key={i} className="flex justify-between gap-2">
                          <span>
                            {barNum(it["quantity"]) || 1} × {barStr(it["item_name"])}
                          </span>
                          {it["special_instructions"] ? (
                            <span className="text-xs text-muted-foreground">
                              {barStr(it["special_instructions"])}
                            </span>
                          ) : null}
                        </li>
                      ))
                    )}
                  </ul>

                  <p className="mt-3 text-xs text-muted-foreground">
                    {assigned
                      ? `Assigned to ${barStr(r["assigned_name"], "attendant")}`
                      : "Unassigned"}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {!assigned && mayAccept ? (
                      <Button
                        size="sm"
                        onClick={() => accept.mutate(id)}
                        disabled={accept.isPending}
                      >
                        Accept order
                      </Button>
                    ) : null}
                    {assigned && next && mayAdvance && (mine || mayReassign) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => advance.mutate({ ticketId: id, to: next })}
                        disabled={advance.isPending}
                      >
                        Mark {next}
                      </Button>
                    ) : null}
                    {mayReassign && assigned ? (
                      <Select
                        value=""
                        disabled={reassign.isPending}
                        onValueChange={(toUser) =>
                          reassign.mutate({
                            ticketId: id,
                            toUser,
                            reason: "Manager reassignment from bar queue",
                          })
                        }
                      >
                        <SelectTrigger className="h-8 w-40 text-xs">
                          <SelectValue placeholder="Reassign to…" />
                        </SelectTrigger>
                        <SelectContent>
                          {(attendants.data ?? []).length === 0 ? (
                            // Without this the list opens empty with no explanation.
                            <SelectItem value="__none" disabled>
                              No attendant on shift
                            </SelectItem>
                          ) : (
                            (attendants.data ?? []).map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

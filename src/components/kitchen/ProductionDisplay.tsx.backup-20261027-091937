import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Maximize, Minimize, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { pairSharedDisplay } from "@/lib/shared-production-display";
import { useAuth } from "@/lib/auth";
import { useSession } from "@/lib/session";
import { pathPermitted } from "@/lib/capabilities";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { PageHeader } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TicketCard } from "@/components/kitchen/TicketCard";
import { TicketAuditSheet } from "@/components/kitchen/TicketAuditSheet";
import { QueryState, EmptyState } from "@/components/kitchen/KitchenShared";
import {
  DISPLAY_LABELS,
  DISPLAY_ROUTES,
  displayStations,
  selectedDisplayStation,
  type DisplayDepartment,
} from "@/lib/production-displays";
import {
  KITCHEN_TICKETS_QUERY_KEY,
  useKitchenTickets,
  useScopedStations,
  useKitchenTicketRealtime,
  useKitchenTicketTransition,
  useKitchenTicketDelay,
  useStationAuthority,
  type KitchenTicket,
} from "@/lib/kitchen-tickets";

export function ProductionDisplay({
  department,
  requestedStation,
}: {
  department: DisplayDepartment;
  requestedStation?: string | undefined;
}) {
  const { can, loading } = useAuth();
  if (loading) return <Skeleton className="h-64" />;
  if (!pathPermitted(can, DISPLAY_ROUTES[department]))
    return <AccessDeniedPanel subject={DISPLAY_LABELS[department]} />;
  return (
    <ScopedDisplay
      key={`${department}:${requestedStation ?? ""}`}
      department={department}
      requestedStation={requestedStation}
    />
  );
}

function ScopedDisplay({
  department,
  requestedStation,
}: {
  department: DisplayDepartment;
  requestedStation?: string | undefined;
}) {
  const scope = useScopedStations();
  const { branchId } = useActivePropertyFilter();
  const { property } = useSession();
  if (!branchId)
    return (
      <AccessDeniedPanel
        reason="setup"
        subject="a station display"
        detail="Choose one property before opening a production display."
      />
    );
  if (scope.isLoading) return <Skeleton className="h-64" />;
  if (scope.error)
    return (
      <QueryState isLoading={false} error={scope.error} isEmpty={false} empty={null}>
        <span />
      </QueryState>
    );
  const stations = displayStations(scope.stations, department);
  if (!stations.length)
    return (
      <AccessDeniedPanel
        reason="setup"
        subject={DISPLAY_LABELS[department]}
        detail="No active stations for this display are available in your property and access scope."
      />
    );
  const selected = selectedDisplayStation(stations, requestedStation);
  if (!selected) return <AccessDeniedPanel reason="scope" subject="the bookmarked station" />;
  return (
    <DisplayBoard
      key={`${branchId}:${selected.id}`}
      department={department}
      stationId={selected.id}
      stations={stations}
      propertyName={property.name}
    />
  );
}

function DisplayBoard({
  department,
  stationId,
  stations,
  propertyName,
}: {
  department: DisplayDepartment;
  stationId: string;
  stations: { id: string; name: string }[];
  propertyName: string;
}) {
  const qc = useQueryClient();
  const { user, can, canExact } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const [pairing, setPairing] = useState(false);
  const canPair =
    canExact("kitchen", "production.manage") ||
    canExact("kitchen", "chef.assign") ||
    canExact("bar", "queue", "assign");
  const { canWorkStation } = useStationAuthority();
  const queue = useKitchenTickets(department === "overview" ? "all" : stationId, "live");
  const transition = useKitchenTicketTransition();
  const delay = useKitchenTicketDelay();
  useKitchenTicketRealtime();
  const [audit, setAudit] = useState<KitchenTicket | null>(null);
  const [full, setFull] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  // Poll as a recovery path when the realtime connection drops; no offline writes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (navigator.onLine) void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
    }, 15000);
    const changed = () => setFull(document.fullscreenElement === panel.current);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("fullscreenchange", changed);
    };
  }, [qc]);
  const allowedIds = new Set(stations.map((s) => s.id));
  const tickets = queue.tickets.filter(
    (t) =>
      t.station_id &&
      allowedIds.has(t.station_id) &&
      (department === "overview" || t.station_id === stationId),
  );
  const readOnly = department === "overview";
  return (
    <div ref={panel} className="space-y-4 bg-background p-4 fullscreen:overflow-auto">
      <PageHeader
        title={DISPLAY_LABELS[department]}
        eyebrow={propertyName}
        description={
          readOnly
            ? "Live progress across your permitted stations."
            : `Personal session: ${user?.email ?? "signed-in staff"}. Actions are recorded against this account.`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {pathPermitted(can, "/staff-display-code") ? (
              <Link to="/staff-display-code" className="rounded-md border px-3 py-2 text-sm">
                My display PIN
              </Link>
            ) : null}
            {canPair ? (
              <>
                <Link to="/production-displays" className="rounded-md border px-3 py-2 text-sm">
                  Shared screen controls
                </Link>
                <Button
                  disabled={pairing || !branchId}
                  onClick={async () => {
                    if (!branchId) return;
                    setPairing(true);
                    try {
                      await pairSharedDisplay(
                        branchId,
                        stations.map((s) => s.id),
                        `${propertyName} · ${DISPLAY_LABELS[department]}`,
                        department === "overview",
                      );
                    } catch (error) {
                      toast.error(
                        error instanceof Error ? error.message : "Could not pair this display.",
                      );
                      setPairing(false);
                    }
                  }}
                >
                  {pairing ? "Pairing…" : "Pair stations & sign out this browser"}
                </Button>
              </>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY })}
            >
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  setFullscreenError("");
                  if (document.fullscreenElement) await document.exitFullscreen();
                  else await panel.current?.requestFullscreen();
                } catch {
                  setFullscreenError(
                    "Fullscreen is unavailable in this browser. The display remains usable here.",
                  );
                }
              }}
            >
              {full ? <Minimize className="mr-2 size-4" /> : <Maximize className="mr-2 size-4" />}
              {full ? "Exit fullscreen" : "Fullscreen"}
            </Button>
          </div>
        }
      />
      {fullscreenError ? (
        <p role="status" className="text-sm">
          {fullscreenError}
        </p>
      ) : null}
      {!readOnly ? (
        <nav aria-label="Display stations" className="flex flex-wrap gap-2">
          {stations.map((s) => (
            <Link
              key={s.id}
              to={DISPLAY_ROUTES[department]}
              search={{ station: s.id }}
              className={`rounded-lg border px-4 py-3 ${s.id === stationId ? "bg-primary text-primary-foreground" : ""}`}
              aria-current={s.id === stationId ? "page" : undefined}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      <QueryState
        isLoading={queue.isLoading}
        error={queue.error}
        isEmpty={!queue.isLoading && !queue.error && tickets.length === 0}
        empty={
          <EmptyState
            title="No live tickets"
            description="Orders appear here when sent to this station."
          />
        }
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {tickets.map((t) => (
            <TicketCard
              key={t.ticket_id}
              ticket={t}
              busy={transition.isPending || delay.isPending}
              stationAuthority={!readOnly && canWorkStation(t.station_id)}
              readOnly={readOnly}
              pendingTo={
                transition.isPending && transition.variables?.ticketId === t.ticket_id
                  ? transition.variables.to
                  : null
              }
              onOpenAudit={() => setAudit(t)}
              onTransition={(to, needsReason) => {
                if (readOnly) return;
                const reason = needsReason ? window.prompt("Reason") : null;
                if (needsReason && !reason?.trim()) return;
                transition.mutate({ ticketId: t.ticket_id, to, ...(reason ? { reason } : {}) });
              }}
              onDelay={() => {
                if (readOnly || !canWorkStation(t.station_id)) return;
                const reason = window.prompt("Reason for delay");
                if (reason?.trim()) delay.mutate({ ticketId: t.ticket_id, reason });
              }}
            />
          ))}
        </div>
      </QueryState>
      <TicketAuditSheet
        ticket={audit}
        onOpenChange={(open) => {
          if (!open) setAudit(null);
        }}
      />
    </div>
  );
}

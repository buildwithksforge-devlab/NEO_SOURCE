/**
 * Kitchen status and booking queue for the staff board.
 *
 * Both halves read the same records the working screens use: live station
 * tickets for the kitchen, and today's reservations plus the waitlist for the
 * front desk. Nothing here writes, and nothing here is estimated — a ticket is
 * late only when its own target minutes say so.
 */
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ChefHat, CalendarClock } from "lucide-react";
import { SectionCard, StatCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useKitchenQueue } from "@/lib/kitchen-data";
import { useReservations, useWaitlist } from "@/lib/pms-data";
import { titleCase } from "@/lib/delivery";

type Row = Record<string, unknown>;

const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));

function waitingMinutes(ticket: Row): number {
  const started = str(ticket["received_at"]) || str(ticket["created_at"]);
  if (!started) return 0;
  const ms = Date.now() - new Date(started).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

export function KitchenStatusCard() {
  const queue = useKitchenQueue("all");
  const tickets = (queue.data ?? []) as Row[];

  const stations = useMemo(() => {
    const map = new Map<
      string,
      { name: string; open: number; late: number; oldest: number }
    >();
    for (const t of tickets) {
      const station = (t["operational_stations"] as Row | null) ?? null;
      const id = str(t["station_id"], "unassigned");
      const entry = map.get(id) ?? {
        name: str(station?.["name"], "Unassigned station"),
        open: 0,
        late: 0,
        oldest: 0,
      };
      const mins = waitingMinutes(t);
      const target = Number(t["target_minutes"] ?? 0) || 15;
      entry.open += 1;
      if (mins > target) entry.late += 1;
      entry.oldest = Math.max(entry.oldest, mins);
      map.set(id, entry);
    }
    return [...map.values()].sort((a, b) => b.late - a.late || b.open - a.open);
  }, [tickets]);

  const open = tickets.length;
  const late = stations.reduce((s, x) => s + x.late, 0);

  return (
    <SectionCard
      title="Kitchen status"
      description="Live preparation tickets by station, with the ones running past their target time."
      icon={ChefHat}
    >
      <QueryState
        isLoading={queue.isLoading}
        error={queue.error}
        isEmpty={open === 0}
        empty="No preparation tickets are open right now."
        skeleton="rows"
      >
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <StatCard label="Open tickets" value={String(open)} />
            <StatCard label="Past target" value={String(late)} tone={late > 0 ? "warning" : "default"} />
            <StatCard label="Stations working" value={String(stations.length)} />
          </div>
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Station</TableHead>
                  <TableHead>Open</TableHead>
                  <TableHead>Past target</TableHead>
                  <TableHead className="text-right">Longest wait</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stations.map((s) => (
                  <TableRow key={s.name}>
                    <TableCell className="font-medium">
                      <Link to="/kitchen/queue" className="hover:underline">
                        {s.name}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular-nums">{s.open}</TableCell>
                    <TableCell>
                      {s.late > 0 ? (
                        <StatusPill tone="warning">{s.late} late</StatusPill>
                      ) : (
                        <span className="text-sm text-muted-foreground">On time</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.oldest} min</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </>
      </QueryState>
    </SectionCard>
  );
}

export function BookingQueueCard() {
  const arrivals = useReservations({ scope: "arrivals" });
  const departures = useReservations({ scope: "departures" });
  const inHouse = useReservations({ scope: "in-house" });
  const waitlist = useWaitlist("waiting");

  const arrivalRows = (arrivals.data ?? []) as Row[];
  const departureRows = (departures.data ?? []) as Row[];
  const inHouseRows = (inHouse.data ?? []) as Row[];
  const waitRows = (waitlist.data ?? []) as Row[];

  const unassigned = arrivalRows.filter((r) => !r["room_id"]).length;

  return (
    <SectionCard
      title="Booking queue"
      description="Today's arrivals and departures, guests in house and anyone still waiting for a room."
      icon={CalendarClock}
    >
      <QueryState
        isLoading={arrivals.isLoading || departures.isLoading || inHouse.isLoading}
        error={arrivals.error ?? departures.error ?? inHouse.error ?? waitlist.error}
        isEmpty={
          arrivalRows.length === 0 &&
          departureRows.length === 0 &&
          inHouseRows.length === 0 &&
          waitRows.length === 0
        }
        empty="No arrivals, departures or waiting guests today."
        skeleton="rows"
      >
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <StatCard label="Arriving today" value={String(arrivalRows.length)} />
            <StatCard label="Departing today" value={String(departureRows.length)} />
            <StatCard label="In house" value={String(inHouseRows.length)} />
            <StatCard
              label="Waiting for a room"
              value={String(waitRows.length)}
              tone={waitRows.length > 0 ? "warning" : "default"}
            />
          </div>
          {unassigned > 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">
              {unassigned} arrival{unassigned === 1 ? "" : "s"} still without a room assigned.
            </p>
          ) : null}
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Booking</TableHead>
                  <TableHead>Guest</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {arrivalRows.slice(0, 15).map((r) => (
                  <TableRow key={str(r["id"])}>
                    <TableCell className="font-medium">
                      <Link
                        to="/pms/reservations/$id"
                        params={{ id: str(r["id"]) }}
                        className="hover:underline"
                      >
                        {str(r["confirmation_number"], "—")}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">
                      {str((r["customers"] as Row | null)?.["full_name"], "—")}
                    </TableCell>
                    <TableCell className="text-sm">
                      {str((r["rooms"] as Row | null)?.["room_number"]) ||
                        str((r["room_types"] as Row | null)?.["name"], "Not assigned")}
                    </TableCell>
                    <TableCell className="text-right">
                      <StatusPill tone="info">{titleCase(str(r["status"], "—"))}</StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </>
      </QueryState>
    </SectionCard>
  );
}

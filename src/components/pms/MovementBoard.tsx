import { PermittedLink } from "@/components/common/PermittedLink";
import { useState } from "react";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BedDouble, CalendarCheck2 } from "lucide-react";
import { Atomic, RowActions, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { formatDate, money, titleCase, today } from "@/lib/pms";
import { useReservations } from "@/lib/pms-data";
import { EmptyState, QueryState, ReservationStatusBadge } from "@/components/pms/PmsShared";
import { RevertCheckInDialog } from "@/components/pms/RevertCheckInDialog";
import {
  AssignRoomDialog,
  CheckInDialog,
  CheckOutDialog,
  PostChargeDialog,
  RecordPaymentDialog,
} from "@/components/pms/ReservationActions";

type Scope = "arrivals" | "departures" | "in-house";

/** Open folio balances keyed by reservation, so the board can block a checkout that still owes money. */
function useOpenFolioIndex() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "folio-index", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("folios").select("id, reservation_id, balance, status"), "folios")
        .in("status", ["open", "under-review", "reopened"]);
      if (error) throw error;
      const index: Record<string, { id: string; balance: number }> = {};
      for (const f of data ?? []) {
        if (f.reservation_id) index[f.reservation_id] = { id: f.id, balance: Number(f.balance) };
      }
      return index;
    },
  });
}

export function MovementBoard({ scope }: { scope: Scope }) {
  const [date, setDate] = useState(today());
  const query = useReservations({ scope, date });
  const folios = useOpenFolioIndex();
  // Viewing the movement board needs `<scope>.view`; acting on a reservation
  // (assign, check in, take payment, check out) needs `<scope>.edit`. Actions
  // are withdrawn rather than shown as dead buttons.
  const { can, isAdmin } = useAuth();
  const mayAct = isAdmin || can("pms", `${scope}.edit`);

  const copy = {
    arrivals: {
      title: "Expected arrivals",
      description: "Assign a room, verify identity, then check the guest in.",
      empty: "No arrivals are expected on this date.",
    },
    departures: {
      title: "Expected departures",
      description: "Settle the folio before releasing the room for cleaning.",
      empty: "No departures are expected on this date.",
    },
    "in-house": {
      title: "In-house guests",
      description: "Guests currently staying, with live folio balances and room moves.",
      empty: "No guests are currently checked in.",
    },
  }[scope];

  return (
    <SectionCard
      title={copy.title}
      description={copy.description}
      actions={
        scope === "in-house" ? null : (
          <NeoDatePicker
            value={date}
            onChange={(v) => setDate(v || today())}
            clearable={false}
            className="w-44"
            quick={["today", "tomorrow", "next-7", "this-month"]}
          />
        )
      }
    >
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={(query.data ?? []).length === 0}
        empty={
          <EmptyState
            icon={scope === "in-house" ? BedDouble : CalendarCheck2}
            title={copy.empty}
            description="Reservations appear here automatically once they are created with matching dates."
            action={
              <Button asChild size="sm" variant="outline">
                <PermittedLink to="/pms/reservations/new">New reservation</PermittedLink>
              </Button>
            }
          />
        }
      >
        <TableScroll>
          <Table className="neo-list-rows">
            <TableHeader>
              <TableRow>
                <TableHead className="neo-sticky-col">Confirmation</TableHead>
                <TableHead>Guest</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Stay</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((r) => {
                const row = r as unknown as ReservationRow;
                const folio = folios.data?.[row.id];
                return (
                  <TableRow key={row.id}>
                    <TableCell className="neo-sticky-col whitespace-nowrap font-mono text-xs">
                      <Link to="/pms/reservations/$id" params={{ id: row.id }} className="text-primary hover:underline">
                        {row.confirmation_number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="neo-line-1 max-w-[14rem] font-medium"
                          title={row.customers?.full_name ?? "Unnamed guest"}
                        >
                          {row.customers?.full_name ?? "Unnamed guest"}
                        </span>
                        {row.is_vip ? <Badge variant="vip">VIP</Badge> : null}
                      </div>
                      <p className="neo-line-1 text-xs text-muted-foreground">
                        {row.adults} adult{row.adults === 1 ? "" : "s"}
                        {row.children ? ` · ${row.children} child` : ""} · {titleCase(row.booking_source)}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.rooms?.room_number ? (
                        <span className="font-medium">{row.rooms.room_number}</span>
                      ) : (
                        <span className="text-xs text-on-tint-warning">Unassigned</span>
                      )}
                      <p className="neo-line-1 max-w-[10rem] text-xs text-muted-foreground">{row.room_types?.name ?? "—"}</p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {formatDate(row.arrival_date)} → {formatDate(row.departure_date)}
                      <p className="text-xs text-muted-foreground">
                        {row.nights} night{row.nights === 1 ? "" : "s"}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <ReservationStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <Atomic>{folio ? money(folio.balance) : "—"}</Atomic>
                    </TableCell>
                    <TableCell>
                      <RowActions>
                        {mayAct && scope === "arrivals" ? (
                          <>
                            <AssignRoomDialog
                              reservation={row}
                              label={row.room_id ? "Change room" : "Assign room"}
                            />
                            <CheckInDialog reservation={row} />
                          </>
                        ) : null}
                        {mayAct && scope === "in-house" ? (
                          <>
                            <AssignRoomDialog reservation={row} label="Move room" transfer />
                            {folio ? <PostChargeDialog folioId={folio.id} /> : null}
                            <RevertCheckInDialog
                              reservationId={row.id}
                              confirmation={row.confirmation_number}
                            />
                          </>
                        ) : null}
                        {mayAct && scope === "departures" ? (
                          <>
                            {folio ? <RecordPaymentDialog folioId={folio.id} balance={folio.balance} /> : null}
                            <CheckOutDialog reservation={row} balance={folio?.balance ?? 0} />
                          </>
                        ) : null}
                      </RowActions>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableScroll>
      </QueryState>
    </SectionCard>
  );
}

export type ReservationRow = {
  id: string;
  confirmation_number: string;
  status: string;
  booking_source: string;
  arrival_date: string;
  departure_date: string;
  nights: number;
  adults: number;
  children: number;
  is_vip: boolean;
  room_id: string | null;
  room_type_id: string | null;
  branch_id: string | null;
  total_amount: number;
  balance: number;
  customers: { full_name: string } | null;
  rooms: { room_number: string } | null;
  room_types: { name: string } | null;
};

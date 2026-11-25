import { QueryState } from "@/components/common/StateSystem";
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PermittedLink as Link } from "@/components/common/PermittedLink";
import {
  BedDouble,
  CalendarCheck2,
  ConciergeBell,
  DoorOpen,
  LogOut,
  ReceiptText,
  Sparkles,
  Users,
} from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { useAuth } from "@/lib/auth";
import { money, today } from "@/lib/pms";
import { useFrontOfficeMetrics, usePostAccommodation } from "@/lib/pms-data";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useBusinessDays } from "@/lib/finance-controls";
import { PmsGuard } from "@/components/pms/PmsShared";
import { MovementBoard } from "@/components/pms/MovementBoard";

export const Route = createFileRoute("/_shell/pms/")({
  head: () => ({
    meta: [
      { title: "Front Office Dashboard — NEØ" },
      {
        name: "description",
        content:
          "Live occupancy, arrivals, departures, folio balances and guest requests for the property.",
      },
      { property: "og:title", content: "Front Office Dashboard — NEØ" },
      {
        property: "og:description",
        content:
          "Live occupancy, arrivals, departures, folio balances and guest requests for the property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="overview.view">
      <FrontOfficeDashboard />
    </PmsGuard>
  ),
});

function FrontOfficeDashboard() {
  const { can } = useAuth();
  const [date, setDate] = useState(today());
  // Dashboard figures and financial posting use the same selected property.
  const { branchId: postingBranchId } = useActivePropertyFilter();
  const metrics = useFrontOfficeMetrics(postingBranchId, date);
  const businessDays = useBusinessDays();
  const postAccommodation = usePostAccommodation();

  const openPostingDays = (businessDays.data ?? []).filter(
    (day) =>
      day.status === "open" &&
      day.branch_id === postingBranchId,
  );

  const postingDay =
    postingBranchId && openPostingDays.length === 1
      ? openPostingDays[0]
      : null;

  const canPostAccommodation =
    Boolean(postingBranchId) &&
    Boolean(postingDay) &&
    !businessDays.isLoading &&
    !businessDays.isFetching &&
    !businessDays.isError &&
    !postAccommodation.isPending;

  const postingUnavailableReason = !postingBranchId
    ? "Select one property before posting accommodation."
    : businessDays.isLoading || businessDays.isFetching
      ? "Checking the property's business day."
      : businessDays.isError
        ? "Business-day information could not be loaded."
        : openPostingDays.length === 0
          ? "This property has no open business day."
          : openPostingDays.length > 1
            ? "Multiple open business days detected. Resolve this before posting."
            : postAccommodation.isPending
              ? "Accommodation posting is in progress."
              : `Post accommodation for ${postingDay?.business_date}`;

  function handlePostAccommodation() {
    if (
      !postingBranchId ||
      !postingDay ||
      !canPostAccommodation
    ) {
      return;
    }

    const confirmed = window.confirm(
      `Post accommodation charges for ${postingDay.business_date}?\n\n` +
        "This will charge eligible in-house guest folios for the selected property only.",
    );

    if (!confirmed) return;

    postAccommodation.mutate({
      branch: postingBranchId,
      operationalDate: postingDay.business_date,
    });
  }


  const m = metrics.data;
  const occupancy =
    m && m.rooms.sellable > 0 ? Math.round((m.rooms.occupied / m.rooms.sellable) * 100) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Front Office Dashboard"
        description="Every figure below is read live from the property management data — nothing is estimated."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <NeoDatePicker
              value={date}
              onChange={(v) => setDate(v || today())}
              clearable={false}
              className="w-44"
              quick={["today", "tomorrow", "next-7", "this-month"]}
            />
            <Button asChild variant="outline" size="sm">
              <Link to="/pms/availability" hideWhenDenied>Check availability</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/pms/reservations/new" hideWhenDenied>New reservation</Link>
            </Button>
          </div>
        }
      />

      {/* One shared dashboard grid: the same contained, density-aware layout
          the role dashboards use, so Front Office is not a bespoke shell. */}
      <QueryState
        isLoading={metrics.isLoading}
        error={metrics.error}
        onRetry={() => void metrics.refetch()}
        isEmpty={false}
        empty={null}
        skeleton="cards"
        skeletonRows={8}
      >
        <div className="neo-kpi-grid">
          <StatCard
            lead
            label="Occupancy"
            value={occupancy === null ? "—" : `${occupancy}%`}
            hint={
              m
                ? `${m.rooms.occupied} of ${m.rooms.sellable} sellable rooms`
                : "Add rooms to measure occupancy"
            }
            icon={BedDouble}
            to="/pms/rack"
            actionLabel="Open room rack"
          />
          <StatCard
            label="Arrivals today"
            value={String(m?.reservations.arrivals_today ?? 0)}
            hint={`${m?.reservations.vip_arrivals ?? 0} VIP · ${m?.reservations.group_arrivals ?? 0} group`}
            icon={DoorOpen}
            tone="accent"
            to="/pms/reservations"
            actionLabel="See arrivals"
          />
          <StatCard
            label="Departures today"
            value={String(m?.reservations.departures_today ?? 0)}
            hint={`${m?.reservations.in_house ?? 0} in house`}
            icon={LogOut}
            to="/pms/reservations"
            actionLabel="See departures"
          />
          <StatCard
            label="Unassigned rooms"
            value={String(m?.reservations.unassigned ?? 0)}
            hint="Confirmed reservations without a room"
            icon={CalendarCheck2}
            tone={m && m.reservations.unassigned > 0 ? "warning" : "default"}
            to="/pms/reservations"
            actionLabel="Assign rooms"
          />
          <StatCard
            label="Vacant &amp; ready"
            value={String(m?.rooms.vacant_clean ?? 0)}
            hint={`${m?.rooms.vacant_dirty ?? 0} awaiting cleaning`}
            icon={Sparkles}
            tone="success"
            to="/pms/rack"
            actionLabel="Open room rack"
          />
          <StatCard
            label="Out of order"
            value={String((m?.rooms.out_of_order ?? 0) + (m?.rooms.maintenance ?? 0))}
            hint="Rooms removed from sale"
            icon={BedDouble}
            tone={m && m.rooms.out_of_order > 0 ? "warning" : "default"}
            to="/pms/rooms"
            actionLabel="Manage rooms"
          />
          <StatCard
            label="Outstanding folios"
            value={money(m?.folios.outstanding_balance ?? 0)}
            hint={`${m?.folios.open ?? 0} open folio(s)`}
            icon={ReceiptText}
            tone={m && Number(m.folios.outstanding_balance) > 0 ? "warning" : "default"}
            to="/pms/folios"
            actionLabel="Open folios"
          />
          <StatCard
            label="Guest requests"
            value={String(m?.requests.open ?? 0)}
            hint={`${m?.requests.overdue ?? 0} overdue · ${m?.waitlist ?? 0} on waitlist`}
            icon={ConciergeBell}
            tone={m && m.requests.overdue > 0 ? "warning" : "default"}
            to="/pms/requests"
            actionLabel="Open requests"
          />
        </div>

      </QueryState>

      <div className="mt-6 space-y-6">
        <MovementBoard scope="arrivals" />
        <MovementBoard scope="departures" />

        <SectionCard
          title="Night audit"
          description="Post the nightly accommodation charge to every in-house folio. Running it twice never double-charges."
          actions={
            can("pms", "folios.post_charge") ? (
              <Button
                size="sm"
                variant="outline"
                title={postingUnavailableReason}
                disabled={!canPostAccommodation}
                onClick={handlePostAccommodation}
              >
                {postAccommodation.isPending
                  ? "Posting accommodation..."
                  : postingDay
                    ? `Post accommodation · ${postingDay.business_date}`
                    : "Post accommodation"}
              </Button>
            ) : null
          }
        >
          <ul className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            <li className="flex items-center gap-2">
              <Users className="size-4" /> {m?.reservations.no_shows ?? 0} no-show(s) recorded for{" "}
              {date}
            </li>
            <li className="flex items-center gap-2">
              <CalendarCheck2 className="size-4" /> {m?.reservations.cancelled ?? 0} cancellation(s)
              recorded for {date}
            </li>
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}

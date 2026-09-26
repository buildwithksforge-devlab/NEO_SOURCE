import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Bike, Navigation2, PackageCheck, Truck } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Lane, LaneBoard } from "@/components/common/LaneBoard";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { RiderRosterCard } from "@/components/delivery/RiderRosterCard";
import { DispatchBoard } from "@/components/delivery/DispatchBoard";
import { ZoneDispatchDashboard } from "@/components/delivery/ZoneDispatchDashboard";
import { RiderShiftsCard } from "@/components/delivery/RiderShiftsCard";
import { RiderPerformanceCard } from "@/components/delivery/RiderPerformanceCard";
import { RiderCashCard } from "@/components/delivery/RiderCashCard";
import { NotificationAuditCard } from "@/components/delivery/NotificationAuditCard";
import { DeliveryZonesCard } from "@/components/delivery/DeliveryZonesCard";
import { PhoneOrderCard } from "@/components/delivery/PhoneOrderCard";
import { StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OrderRiderSelect } from "@/components/delivery/OrderRiderSelect";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import {
  countDeliveryStages,
  DELIVERY_STAGES,
  deliveryStageLabel,
  dispatchStatusTone,
  money,
  orderStatusTone,
  resolveDeliveryStage,
  riderEligibility,
  shortDateTime,
  titleCase,
  type DeliveryStageId,
  type DeliveryStageInput,
} from "@/lib/delivery";
import {
  useAssignRider,
  useDeliveryIssues,
  useDeliveryMetrics,
  useOrderAction,
  useRiders,
  useDeliveryStageRealtime,
  useStaffDeliveryOrders,
} from "@/lib/delivery-data";

export const Route = createFileRoute("/_shell/delivery/")({
  head: () => ({
    meta: [
      { title: "Delivery — NEØ Hospitality OS" },
      {
        name: "description",
        content: "Delivery order intake, kitchen status, rider dispatch and payment tracking.",
      },
      { property: "og:title", content: "Delivery — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "Delivery order intake, kitchen status, rider dispatch and payment tracking.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

type Row = Record<string, unknown>;

/**
 * Lanes and KPI counts both come from the shared stage calculation, so the
 * dashboard can never disagree with the delivery queue or the rider app.
 */
type Focus = "none" | DeliveryStageId | "issues";

function Page() {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();

  const [search, setSearch] = useState("");
  const [focus, setFocus] = useState<Focus>("none");
  const [inspectId, setInspectId] = useState<string | null>(null);

  const orders = useStaffDeliveryOrders({ branchId, status: "all" });
  const metrics = useDeliveryMetrics(branchId);
  const riders = useRiders(branchId);
  const issues = useDeliveryIssues();
  const action = useOrderAction();
  const assign = useAssignRider();
  // The kitchen marking a ticket ready must move the order on this board at
  // once — both tables that decide the stage are watched.
  useDeliveryStageRealtime();

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (orders.data ?? []).filter((o: Row) => {
      if (!q) return true;
      return (
        String(o["order_number"] ?? "")
          .toLowerCase()
          .includes(q) ||
        String(o["contact_name"] ?? "")
          .toLowerCase()
          .includes(q) ||
        String(o["contact_phone"] ?? "")
          .toLowerCase()
          .includes(q)
      );
    });
  }, [orders.data, search]);

  const m = metrics.data ?? {};
  const roster = riders.data ?? [];
  /**
   * A rider counts as available only when they can actually be given an order
   * now: active account, a shift running, availability set to available and
   * spare capacity. The tile states the count as eligible out of the roster and
   * always says why the others cannot take work.
   */
  const dispatchable = roster.filter((r) => r.active);
  const eligibleRiders = dispatchable.filter((r) => riderEligibility(r, { branchId }).eligible);
  const riderBlockers = (() => {
    if (!dispatchable.length) return "no riders on the dispatch board";
    const counts = new Map<string, number>();
    for (const r of dispatchable) {
      const status = riderEligibility(r, { branchId });
      if (status.eligible) continue;
      const first = status.blockers[0] ?? "not eligible";
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    if (counts.size === 0) return `all ${dispatchable.length} can take work now`;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n} ${reason.toLowerCase()}`)
      .join(" · ");
  })();
  const openIssues = (issues.data ?? []).filter((i: Row) => String(i["status"]) !== "resolved");

  const stageCounts = useMemo(
    () => countDeliveryStages((orders.data ?? []) as DeliveryStageInput[]),
    [orders.data],
  );
  const waitingCount = stageCounts["awaiting-rider"];
  const withRiderCount = stageCounts["with-rider"];
  const inFlightCount = stageCounts["in-flight"];

  const focused = useMemo(() => {
    if (focus === "none" || focus === "issues") return searched;
    return searched.filter((o: Row) => resolveDeliveryStage(o as DeliveryStageInput) === focus);
  }, [searched, focus]);

  const lanes: Lane<Row>[] = DELIVERY_STAGES.map((stage) => ({
    id: stage.id,
    label: stage.label,
    tone: mapTone(stage.tone),
    items: focused.filter((o: Row) => resolveDeliveryStage(o as DeliveryStageInput) === stage.id),
  }));

  const inspected = (orders.data ?? []).find((o: Row) => String(o["id"]) === inspectId) ?? null;

  const toggleFocus = (next: Focus) => setFocus((prev: Focus) => (prev === next ? "none" : next));

  const leadFigure: SummaryFigure = {
    id: "orders",
    label: "Orders",
    value: String(m["orders"] ?? 0),
    hint: "in the current window",
  };
  const figures: SummaryFigure[] = [
    {
      id: "kitchen",
      label: "In kitchen",
      value: String(stageCounts["kitchen"]),
      hint: "kitchen has not finished",
      tone: stageCounts["kitchen"] > 0 ? "info" : "default",
      onSelect: () => toggleFocus("kitchen"),
      active: focus === "kitchen",
    },
    {
      id: "awaiting-rider",
      label: "Waiting for rider",
      value: String(waitingCount),
      hint: "kitchen ready, no rider yet",
      tone: waitingCount > 0 ? "warning" : "default",
      onSelect: () => toggleFocus("awaiting-rider"),
      active: focus === "awaiting-rider",
    },
    {
      id: "with-rider",
      label: "With rider",
      value: String(withRiderCount),
      hint: "rider assigned, waiting for pickup",
      tone: withRiderCount > 0 ? "info" : "default",
      onSelect: () => toggleFocus("with-rider"),
      active: focus === "with-rider",
    },
    {
      id: "in-flight",
      label: "In flight",
      value: String(inFlightCount),
      hint: "rider has confirmed pickup",
      tone: "info",
      onSelect: () => toggleFocus("in-flight"),
      active: focus === "in-flight",
    },
    {
      id: "closed",
      label: "Delivered & closed",
      value: String(stageCounts["closed"]),
      hint: "delivery completed",
      tone: "success",
      onSelect: () => toggleFocus("closed"),
      active: focus === "closed",
    },
    {
      id: "riders",
      label: "Eligible riders",
      value: riders.isLoading ? "…" : `${eligibleRiders.length}/${dispatchable.length}`,
      hint: riderBlockers,
      tone: eligibleRiders.length ? "accent" : "warning",
    },

    {
      id: "issues",
      label: "Open issues",
      value: String(openIssues.length),
      hint: "reported failures and disputes",
      tone: openIssues.length ? "warning" : "success",
    },
  ];

  return (
    <OpsGuard module="delivery">
      <PageHeader
        eyebrow="Food & Beverage"
        title="Delivery control"
        icon={Truck}
        description="Live delivery orders with kitchen status, rider dispatch and payment outcome — every transition is validated in the database."
        meta={
          <>
            <StatusPill tone={openIssues.length ? "warning" : "success"}>
              {openIssues.length
                ? `${openIssues.length} open ${openIssues.length === 1 ? "issue" : "issues"}`
                : "No open issues"}
            </StatusPill>
            <StatusPill tone={eligibleRiders.length ? "info" : "warning"}>
              {eligibleRiders.length
                ? `${eligibleRiders.length} of ${dispatchable.length} riders can take work`
                : `No rider can take work — ${riderBlockers}`}
            </StatusPill>

          </>
        }
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <div className="neo-filter-bar mb-4">
        <Input
          className="w-full sm:w-72"
          placeholder="Search order, customer or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <QueryState
        isLoading={orders.isLoading}
        error={orders.error}
        isEmpty={focused.length === 0}
        empty={
          <EmptyState
            title="No delivery orders"
            description="Orders placed through the customer delivery app appear here in real time with their linked POS and kitchen records."
            icon={Truck}
          />
        }
      >
        <LaneBoard
          lanes={lanes}
          getKey={(o) => String(o["id"])}
          emptyLaneLabel="Nothing here"
          className="mb-6"
          renderItem={(o: Row) => (
            <button
              type="button"
              data-touch-target
              onClick={() => setInspectId(String(o["id"]))}
              className="w-full min-w-0 text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="neo-line-1 text-sm font-semibold">
                  {String(o["order_number"] ?? "—")}
                </p>
                <StatusPill tone={mapTone(orderStatusTone(String(o["order_status"])))}>
                  {deliveryStageLabel(resolveDeliveryStage(o as DeliveryStageInput))}
                </StatusPill>
              </div>
              <p className="neo-line-1 mt-0.5 text-xs text-muted-foreground">
                {String(o["contact_name"] ?? "—")}
              </p>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{shortDateTime(o["created_at"] as string)}</span>
                <span className="font-medium text-foreground">{money(o["grand_total"] as number)}</span>
              </div>
            </button>
          )}
        />
      </QueryState>

      <div className="mt-6">
        <PhoneOrderCard branchId={branchId} />
      </div>

      <div className="mt-6">
        <ZoneDispatchDashboard branchId={branchId} />
      </div>

      <div className="mt-6">
        <DispatchBoard branchId={branchId} />
      </div>

      <div className="mt-6">
        <DeliveryZonesCard branchId={branchId} />
      </div>

      <div className="mt-6">
        <RiderPerformanceCard branchId={branchId} />
      </div>

      <div className="mt-6">
        <RiderCashCard />
      </div>

      <div className="mt-6">
        <NotificationAuditCard branchId={branchId} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <RiderRosterCard branchId={branchId} />

        <RiderShiftsCard branchId={branchId} />

        <SectionCard
          title="Open delivery issues"
          description="Reported failures and disputes awaiting resolution."
        >
          <QueryState
            isLoading={issues.isLoading}
            error={issues.error}
            isEmpty={openIssues.length === 0}
            empty={
              <EmptyState
                title="No open issues"
                description="Failed deliveries, disputes and rider-reported problems appear here."
                icon={Truck}
              />
            }
          >
            <div className="space-y-2">
              {openIssues.map((i: Row) => (
                <div key={String(i["id"])} className="rounded-lg border border-border/70 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {titleCase(String(i["category"] ?? "Issue"))}
                    </p>
                    <StatusPill tone="warning">
                      {titleCase(String(i["status"] ?? "open"))}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {String(i["description"] ?? "")}
                  </p>
                </div>
              ))}
            </div>
          </QueryState>
        </SectionCard>
      </div>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(open) => !open && setInspectId(null)}
        title={inspected ? String(inspected["order_number"] ?? "Order") : "Order"}
        subtitle={inspected ? shortDateTime(inspected["created_at"] as string) : undefined}
        chips={
          inspected ? (
            <>
              <StatusPill tone={mapTone(orderStatusTone(String(inspected["order_status"])))}>
                {titleCase(String(inspected["order_status"]))}
              </StatusPill>
              <StatusPill tone={mapTone(dispatchStatusTone(String(inspected["dispatch_status"])))}>
                {titleCase(String(inspected["dispatch_status"]))}
              </StatusPill>
            </>
          ) : undefined
        }
        footer={
          inspected ? (
            <>
              {["pending-payment", "payment-verification", "draft"].includes(
                String(inspected["order_status"]),
              ) && can("delivery", "edit") ? (
                <>
                  <Button
                    size="sm"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({ action: "accept", orderId: String(inspected["id"]) })
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({
                        action: "reject",
                        orderId: String(inspected["id"]),
                        reason: "Rejected by staff",
                      })
                    }
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              {["ready-for-pickup", "in-preparation", "confirmed"].includes(
                String(inspected["order_status"]),
              ) && can("delivery", "edit") ? (
                <OrderRiderSelect
                  orderId={String(inspected["id"])}
                  riderId={inspected["rider_id"] ? String(inspected["rider_id"]) : null}
                  disabled={assign.isPending}
                  onAssign={(riderId) =>
                    assign.mutate({ orderId: String(inspected["id"]), riderId })
                  }
                />
              ) : null}
            </>
          ) : null
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Customer">
              <InspectorField label="Name">{String(inspected["contact_name"] ?? "—")}</InspectorField>
              <InspectorField label="Phone">{String(inspected["contact_phone"] ?? "—")}</InspectorField>
            </InspectorSection>
            <InspectorSection title="Order">
              <InspectorField label="Kitchen">
                {titleCase(String(inspected["kitchen_status"] ?? ""))}
              </InspectorField>
              <InspectorField label="Payment">
                {titleCase(String(inspected["payment_status"] ?? ""))}
              </InspectorField>
              <InspectorField label="Total">{money(inspected["grand_total"] as number)}</InspectorField>
            </InspectorSection>
          </>
        ) : null}
      </InspectorSheet>
    </OpsGuard>
  );
}

/** Delivery tones use "neutral"; the shared pill uses "default". */
function mapTone(tone: string): "default" | "success" | "warning" | "info" | "destructive" {
  return tone === "neutral" ? "default" : (tone as "success" | "warning" | "info" | "destructive");
}

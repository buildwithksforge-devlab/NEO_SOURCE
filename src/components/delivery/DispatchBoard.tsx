/**
 * Live delivery dispatch board — unassigned orders on one side, real rider
 * capacity (availability, active load, shift cover) on the other. Assignment
 * is validated in the database; the browser only proposes a rider.
 */
import { useState } from "react";
import { Bike, Clock, Truck } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { AssignRiderDialog } from "@/components/delivery/AssignRiderDialog";
import { useAuth } from "@/lib/auth";
import { money, riderEligibility, riderStatusTone, shortDateTime, titleCase } from "@/lib/delivery";
import { useDispatchBoard } from "@/lib/delivery-data";
import { useCourierConnected, useCourierJobs, useSendToCourier } from "@/lib/delivery-dispatch-gateway";
import { RpcAccessNotice } from "@/components/common/RpcAccessNotice";
import { requiresReauthentication } from "@/lib/rpc-telemetry";

function tone(t: string) {
  return t === "neutral" ? "default" : (t as "success" | "warning" | "info" | "destructive");
}

export function DispatchBoard({ branchId }: { branchId?: string | null | undefined }) {
  const { can } = useAuth();
  const mayAssign = can("delivery", "dispatch.assign");
  const board = useDispatchBoard(branchId);
  const [target, setTarget] = useState<{ id: string; number: string } | null>(null);

  const riders = board.data?.riders ?? [];
  const eligibleRiders = riders.filter((r) => riderEligibility(r).eligible);
  const queue = board.data?.queue ?? [];
  const courier = useCourierConnected();
  const jobs = useCourierJobs(queue.map((o) => o.order_id));
  const sendToCourier = useSendToCourier();
  const accessBlocked = requiresReauthentication(board.error);

  if (accessBlocked) {
    return (
      <RpcAccessNotice
        context="The dispatch board"
        onRetry={() => void board.refetch()}
        retrying={board.isFetching}
      />
    );
  }


  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <SectionCard
        title="Dispatch queue"
        description="Orders waiting for a rider. Waiting time counts from the moment the kitchen marked them ready."
      >
        <QueryState
          isLoading={board.isLoading}
          error={board.error}
          isEmpty={queue.length === 0}
          empty={<EmptyState title="Nothing waiting" description="Every live order already has a rider assigned." />}
        >
          <div className="space-y-3">
            {queue.map((order) => (
              <div
                key={order.order_id}
                className="rounded-lg border border-border/60 bg-card/40 p-3 sm:flex sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{order.order_number}</span>
                    <StatusPill tone={order.waiting_minutes > 20 ? "destructive" : "warning"}>
                      <Clock className="mr-1 inline h-3 w-3" />
                      {order.waiting_minutes}m waiting
                    </StatusPill>
                    <StatusPill tone="default">{titleCase(order.order_status)}</StatusPill>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {order.contact_name ?? "Guest"} · {money(order.grand_total)} ·{" "}
                    {titleCase(order.payment_method ?? "unspecified")} · requested {shortDateTime(order.requested_at)}
                  </p>
                </div>
                {mayAssign ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 sm:mt-0">
                    <Button
                      size="sm"
                      onClick={() => setTarget({ id: order.order_id, number: order.order_number })}
                    >
                      Assign rider
                    </Button>
                    {courier.data?.connected ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={sendToCourier.isPending || Boolean(jobs.data?.get(order.order_id))}
                        onClick={() => sendToCourier.mutate({ orderId: order.order_id })}
                      >
                        <Truck className="mr-1.5 h-4 w-4" />
                        {jobs.data?.get(order.order_id)
                          ? `Courier: ${titleCase(String(jobs.data.get(order.order_id)?.state ?? ""))}`
                          : "Send to courier"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}

          </div>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Rider availability"
        description="A rider can only be given work when the account is active, a shift is running now, availability is set to available and there is spare capacity."
        actions={
          <StatusPill tone={eligibleRiders.length ? "success" : "warning"}>
            Eligible riders: {eligibleRiders.length}/{riders.length}
          </StatusPill>
        }
      >
        <QueryState
          isLoading={board.isLoading}
          error={board.error}
          isEmpty={riders.length === 0}
          empty={<EmptyState title="No riders on the roster" description="Enrol staff who hold a rider capability." />}
        >
          <div className="space-y-2">
            {riders.map((r) => {
              const status = riderEligibility(r);
              return (
              <div
                key={r.rider_id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    <Bike className="mr-1 inline h-3.5 w-3.5" />
                    {r.display_name ?? "Rider"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.rider_code ?? "—"} · {titleCase(r.vehicle_type ?? "unspecified")} · {r.delivered_today} delivered
                    today
                    {r.next_shift && !r.on_shift ? ` · next shift ${shortDateTime(r.next_shift)}` : ""}
                  </p>
                  {status.eligible ? null : (
                    <p className="text-xs text-muted-foreground">Cannot take work — {status.blockers.join(" · ")}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill tone={r.on_shift ? "success" : "warning"}>
                    {r.on_shift ? "On shift" : "Off shift"}
                  </StatusPill>
                  <StatusPill tone={tone(riderStatusTone(r.availability_status ?? ""))}>
                    {titleCase(r.availability_status ?? "unknown")}
                  </StatusPill>
                  <StatusPill tone={r.active_load >= (r.max_active ?? 3) ? "destructive" : "default"}>
                    {r.active_load}/{r.max_active}
                  </StatusPill>
                  <StatusPill tone={status.eligible ? "success" : "destructive"}>
                    {status.eligible ? "Eligible" : "Not eligible"}
                  </StatusPill>
                </div>
              </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <AssignRiderDialog
        orderId={target?.id ?? null}
        orderNumber={target?.number ?? null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      />
    </div>

  );
}

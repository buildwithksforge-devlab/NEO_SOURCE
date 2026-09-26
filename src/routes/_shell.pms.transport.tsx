import { guardedRpc } from "@/lib/rpc-guard";
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { transportStatusLabels } from "@/lib/guest-ordering";
import { useTransportRiderCandidates } from "@/lib/delivery-data";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export const Route = createFileRoute("/_shell/pms/transport")({
  head: () => ({
    meta: [
      { title: "Transport & Transfers — NEØ" },
      {
        name: "description",
        content:
          "Guest transfer requests with quoting, confirmation, driver assignment and completion.",
      },
      { property: "og:title", content: "Transport & Transfers — NEØ" },
      {
        property: "og:description",
        content:
          "Guest transfer requests with quoting, confirmation, driver assignment and completion.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="requests.view">
      <TransportPage />
    </PmsGuard>
  ),
});

type Row = Record<string, unknown>;
const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const STATUS_FILTERS = [
  "open",
  "requested",
  "quoted",
  "confirmed",
  "completed",
  "cancelled",
] as const;

function useTransferRequests(filter: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["staff-transport", filter, filterKey],
    queryFn: async () => {
      let query = applyTo(
        sb
          .from("transport_requests")
          .select(
            "id, request_number, status, category, pickup_at, pickup_point, destination, passengers, luggage_count, travel_reference, notes, quoted_amount, currency, customer_id, assigned_rider_id, customers(full_name, phone)",
          ),
        "transport_requests",
      )
        .order("pickup_at", { ascending: true })
        .limit(200);
      query =
        filter === "open"
          ? query.in("status", [
              "requested",
              "quoted",
              "confirmed",
              "driver-assigned",
              "arriving",
              "picked-up",
            ])
          : query.eq("status", filter);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

function TransportPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>("open");
  const requests = useTransferRequests(filter);
  const mayManage = can("front-office", "requests.edit");
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const setStatus = useMutation({
    mutationFn: async (input: {
      id: string;
      status: string;
      amount?: number | null;
      note?: string | null;
      riderId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(sb, "neo_transport_set_status", {
        _request: input.id,
        _status: input.status,
        _rider: input.riderId ?? null,
        _amount: input.amount ?? null,
        _note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      toast.success("Transfer updated");
      void qc.invalidateQueries({ queryKey: ["staff-transport"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = requests.data ?? [];

  return (
    <div>
      <PageHeader
        title="Transport & transfers"
        description="Guest transfer requests from the NEØ Guest app — quote, confirm and close them here."
      />

      <SectionCard
        title="Requests"
        actions={
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "open" ? "Open" : (transportStatusLabels[value] ?? value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <QueryState
          isLoading={requests.isLoading}
          error={requests.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No transfer requests"
              description="Guest transfer requests appear here as they come in."
            />
          }
        >
          {
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Request</TableHead>
                    <TableHead>Guest</TableHead>
                    <TableHead>Pickup</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const id = String(r["id"]);
                    const status = String(r["status"]);
                    const guest =
                      (r["customers"] as { full_name?: string } | null)?.full_name ?? "Guest";
                    return (
                      <TableRow key={id}>
                        <TableCell className="font-medium">{String(r["request_number"])}</TableCell>
                        <TableCell>{guest}</TableCell>
                        <TableCell>{new Date(String(r["pickup_at"])).toLocaleString()}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {String(r["pickup_point"])} → {String(r["destination"])}
                          <span className="block text-xs">
                            {String(r["passengers"] ?? 1)} pax · {String(r["luggage_count"] ?? 0)}{" "}
                            bags
                            {r["travel_reference"] ? ` · ${String(r["travel_reference"])}` : ""}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusPill>{transportStatusLabels[status] ?? status}</StatusPill>
                          {r["quoted_amount"] != null ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {String(r["currency"] ?? "KES")}{" "}
                              {Number(r["quoted_amount"]).toFixed(2)}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          {!mayManage ? (
                            <span className="text-xs text-muted-foreground">View only</span>
                          ) : status === "requested" ? (
                            <div className="flex items-center justify-end gap-2">
                              <Label htmlFor={`amount-${id}`} className="sr-only">
                                Quote amount
                              </Label>
                              <Input
                                id={`amount-${id}`}
                                className="w-28"
                                inputMode="decimal"
                                placeholder="Amount"
                                value={amounts[id] ?? ""}
                                onChange={(e) =>
                                  setAmounts((prev) => ({ ...prev, [id]: e.target.value }))
                                }
                              />
                              <Button
                                size="sm"
                                disabled={setStatus.isPending}
                                onClick={() =>
                                  setStatus.mutate({
                                    id,
                                    status: "quoted",
                                    amount: amounts[id] ? Number(amounts[id]) : null,
                                  })
                                }
                              >
                                Quote
                              </Button>
                            </div>
                          ) : status === "quoted" ? (
                            <Button
                              size="sm"
                              disabled={setStatus.isPending}
                              onClick={() => setStatus.mutate({ id, status: "confirmed" })}
                            >
                              Confirm
                            </Button>
                          ) : ["confirmed", "driver-assigned", "arriving", "picked-up"].includes(
                              status,
                            ) ? (
                            <div className="flex items-center justify-end gap-2">
                              <AssignDriver
                                requestId={id}
                                assigned={(r["assigned_rider_id"] as string | null) ?? null}
                                disabled={setStatus.isPending}
                                onAssign={(riderId) =>
                                  setStatus.mutate({ id, status: "driver-assigned", riderId })
                                }
                              />
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={setStatus.isPending}
                                onClick={() => setStatus.mutate({ id, status: "completed" })}
                              >
                                Complete
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Closed</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
          }
        </QueryState>
      </SectionCard>
    </div>
  );
}

/**
 * Driver assignment for a confirmed transfer. Candidates come from a database
 * routine that only returns riders in the same tenant and property scope, so
 * the picker can never reach another property's roster.
 */
function AssignDriver({
  requestId,
  assigned,
  disabled,
  onAssign,
}: {
  requestId: string;
  assigned: string | null;
  disabled: boolean;
  onAssign: (riderId: string) => void;
}) {
  const candidates = useTransportRiderCandidates(requestId);
  const rows = candidates.data ?? [];
  return (
    <Select value={assigned ?? ""} onValueChange={onAssign} disabled={disabled}>
      <SelectTrigger className="w-48">
        <SelectValue placeholder={rows.length ? "Assign driver" : "No eligible drivers"} />
      </SelectTrigger>
      <SelectContent>
        {rows
          .filter((r) => r.eligible)
          .map((r) => (
            <SelectItem key={r.rider_id} value={r.rider_id}>
              {r.display_name ?? r.rider_code ?? "Driver"} · {r.active_load} active
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

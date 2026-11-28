import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useOpenContainers, formatMl } from "@/lib/bottle-stock";
import {
  useOpenVolumeTransfers,
  useDispatchOpenVolumeTransfer,
  useFinishOpenVolumeTransfer,
  type OpenVolumeDispatchInput,
} from "@/lib/open-volume-transfers";

export function OpenVolumeTransferCard() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();

  const scope = `${organizationId ?? ""}:${branchId ?? ""}`;

  return <OpenVolumeTransferWorkspace key={scope} />;
}

function OpenVolumeTransferWorkspace() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();

  const pools = useOpenContainers();
  const transfers = useOpenVolumeTransfers();
  const dispatch = useDispatchOpenVolumeTransfer();
  const finish = useFinishOpenVolumeTransfer();

  const [poolId, setPoolId] = useState("");
  const [destination, setDestination] = useState("");
  const [volume, setVolume] = useState("");
  const [containers, setContainers] = useState("1");
  const [reason, setReason] = useState("");
  const [pendingInput, setPendingInput] =
    useState<OpenVolumeDispatchInput | null>(null);

  const [decision, setDecision] = useState<{
    id: string;
    action: "receive" | "cancel";
    label: string;
  } | null>(null);

  const [decisionReason, setDecisionReason] = useState("");

  const locations = useQuery({
    queryKey: ["inventory", "open-transfer-locations", organizationId, branchId],
    enabled: Boolean(organizationId && branchId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, name")
        .eq("organization_id", organizationId!)
        .eq("branch_id", branchId!)
        .eq("active", true)
        .order("name");

      if (error) throw error;
      return data ?? [];
    },
  });

  const pool = pools.data?.find((row) => row.id === poolId);
  const ml = Number(volume);
  const count = Number(containers);
  const capacity = Number(pool?.stock_items?.container_volume_ml ?? 0);

  const remainingMl = Number(pool?.open_volume_ml ?? 0) - ml;
  const remainingCount = Number(pool?.containers_open ?? 0) - count;

  const valid = Boolean(
    pool &&
    destination &&
    destination !== pool.location_id &&
    Number.isFinite(ml) &&
    ml > 0 &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    capacity > 0 &&
    remainingMl >= 0 &&
    remainingCount >= 0 &&
    ml <= count * capacity &&
    remainingMl <= remainingCount * capacity &&
    !(remainingMl === 0 && remainingCount !== 0) &&
    reason.trim().length >= 3
  );

  const locked = Boolean(pendingInput) || dispatch.isPending;
  const rows = transfers.data ?? [];
  const inTransit = rows.filter((row) => row.status === "in-transit");
  const unvalued = inTransit.filter((row) => row.inventory_value === null);

  if (!branchId) {
    return (
      <section className="rounded-xl border p-4">
        Select a property to manage opened-stock transfers.
      </section>
    );
  }

  if (transfers.isError) {
    return (
      <section className="rounded-xl border p-4 space-y-2">
        <h3 className="font-semibold">Opened-stock transfers</h3>
        <p className="text-sm text-muted-foreground">
          The transfer register is unavailable or outside your access.
        </p>
        <Button variant="outline" onClick={() => void transfers.refetch()}>
          Retry
        </Button>
      </section>
    );
  }

  async function submitTransfer() {
    if (dispatch.isPending) return;

    const input = pendingInput ?? (
      pool && valid
        ? {
            stockItemId: pool.stock_item_id,
            fromLocationId: pool.location_id,
            toLocationId: destination,
            volumeMl: ml,
            containerCount: count,
            attempt: crypto.randomUUID(),
            reason: reason.trim(),
          }
        : null
    );

    if (!input) return;

    setPendingInput(input);

    try {
      await dispatch.mutateAsync(input);

      setPendingInput(null);
      setPoolId("");
      setDestination("");
      setVolume("");
      setContainers("1");
      setReason("");
    } catch {
      // Retain the original transfer identity for a safe retry.
    }
  }

  return (
    <section className="rounded-xl border p-4 space-y-5">
      <div>
        <h3 className="text-lg font-semibold">Opened-stock transfers</h3>
        <p className="text-sm text-muted-foreground">
          Move existing opened containers using their measured remaining volume.
          Sealed stock is not deducted.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="open-transfer-source">Source item and store</Label>
          <select
            id="open-transfer-source"
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={poolId}
            disabled={locked || pools.isLoading || pools.isError}
            onChange={(event) => {
              setPoolId(event.target.value);
              setDestination("");
              setVolume("");
            }}
          >
            <option value="">Select available open stock</option>
            {(pools.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {row.stock_items?.name ?? "Stock item"} —{" "}
                {row.stock_locations?.name ?? "Store"} —{" "}
                {formatMl(Number(row.open_volume_ml))}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="open-transfer-destination">Destination store</Label>
          <select
            id="open-transfer-destination"
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={destination}
            disabled={locked || !pool || locations.isError}
            onChange={(event) => setDestination(event.target.value)}
          >
            <option value="">Select destination</option>
            {(locations.data ?? [])
              .filter((row) => row.id !== pool?.location_id)
              .map((row) => (
                <option key={row.id} value={row.id}>{row.name}</option>
              ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="open-transfer-volume">Measured volume (ml)</Label>
          <Input
            id="open-transfer-volume"
            type="number"
            min="0"
            step="any"
            value={volume}
            disabled={locked}
            onChange={(event) => setVolume(event.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="open-transfer-count">Opened containers</Label>
          <Input
            id="open-transfer-count"
            type="number"
            min="1"
            step="1"
            value={containers}
            disabled={locked}
            onChange={(event) => setContainers(event.target.value)}
          />
        </div>

        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="open-transfer-reason">Transfer reason</Label>
          <Input
            id="open-transfer-reason"
            value={reason}
            maxLength={500}
            disabled={locked}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>

      {pool ? (
        <div className="rounded-md border p-3 text-sm">
          Available: {formatMl(Number(pool.open_volume_ml))} across{" "}
          {pool.containers_open} opened container(s).
          {valid ? (
            <div>
              Remaining after dispatch: {formatMl(remainingMl)} across{" "}
              {remainingCount} container(s).
            </div>
          ) : null}
        </div>
      ) : null}

      {pools.isError || locations.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Stock balances or destination stores could not be loaded.
        </p>
      ) : null}

      {pendingInput && dispatch.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The transfer was not confirmed. Retry the original submission
          to avoid a duplicate dispatch.
        </p>
      ) : null}

      <Button
        disabled={
          dispatch.isPending ||
          !transfers.isSuccess ||
          (!valid && !pendingInput)
        }
        onClick={() => void submitTransfer()}
      >
        {dispatch.isPending
          ? "Dispatching..."
          : pendingInput
            ? "Retry original dispatch"
            : "Dispatch opened stock"}
      </Button>

      <div className="border-t pt-4 space-y-3">
        <h4 className="font-semibold">Transfer register</h4>

        <div className="text-sm text-muted-foreground">
          In transit: {inTransit.length} transfer(s).
          {unvalued.length > 0
            ? ` ${unvalued.length} require valuation review.`
            : ""}
        </div>

        {transfers.isLoading ? (
          <p className="text-sm">Loading transfers...</p>
        ) : null}

        {transfers.isSuccess && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No opened-stock transfers recorded.
          </p>
        ) : null}

        {rows.map((row) => (
          <div key={row.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium">{row.item_name}</span>
              <span className="rounded border px-2 py-1 text-xs">
                {row.status}
              </span>
            </div>

            <div className="text-sm">
              {row.source_name} → {row.destination_name}
            </div>

            <div className="text-sm text-muted-foreground">
              {formatMl(Number(row.volume_ml))} ·{" "}
              {row.container_count} container(s)
            </div>

            <div className="text-sm">
              {row.inventory_value === null
                ? "Inventory valuation requires review"
                : `Carrying value: ${Number(row.inventory_value).toFixed(2)}`}
            </div>

            <div className="text-xs text-muted-foreground">
              {row.reason}
            </div>

            {row.status === "in-transit" ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={finish.isPending}
                  onClick={() => {
                    setDecisionReason("");
                    setDecision({
                      id: row.id,
                      action: "receive",
                      label: row.item_name,
                    });
                  }}
                >
                  Confirm receipt
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={finish.isPending}
                  onClick={() => {
                    setDecisionReason("");
                    setDecision({
                      id: row.id,
                      action: "cancel",
                      label: row.item_name,
                    });
                  }}
                >
                  Cancel transfer
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {decision ? (
        <div className="rounded-xl border p-4 space-y-3">
          <h4 className="font-medium">
            {decision.action === "receive"
              ? "Confirm physical receipt"
              : "Confirm physical return"} — {decision.label}
          </h4>

          <p className="text-sm text-muted-foreground">
            {decision.action === "receive"
              ? "Confirm only after the measured stock has arrived."
              : "Cancel only after the stock is physically back at its source."}
          </p>

          {decision.action === "cancel" ? (
            <Input
              aria-label="Cancellation reason"
              placeholder="Reason for cancellation"
              value={decisionReason}
              disabled={finish.isPending}
              onChange={(event) => setDecisionReason(event.target.value)}
            />
          ) : null}

          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={finish.isPending}
              onClick={() => setDecision(null)}
            >
              Back
            </Button>
            <Button
              disabled={
                finish.isPending ||
                (
                  decision.action === "cancel" &&
                  decisionReason.trim().length < 3
                )
              }
              onClick={async () => {
                try {
                  await finish.mutateAsync({
                    transferId: decision.id,
                    action: decision.action,
                    reason: decisionReason,
                  });
                  setDecision(null);
                  setDecisionReason("");
                } catch {
                  // Preserve the decision for retry or correction.
                }
              }}
            >
              {finish.isPending ? "Confirming..." : "Confirm"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
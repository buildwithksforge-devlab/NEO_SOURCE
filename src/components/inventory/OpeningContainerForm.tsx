import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import {
  useRegisterOpeningContainer,
  newOpeningContainerReference,
  type OpeningContainerInput,
} from "@/lib/bottle-stock";

type OpeningItem = {
  id: string;
  name: string;
  container_volume_ml: number | null;
};

type Store = {
  id: string;
  name: string;
};

export function OpeningContainerForm() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const register = useRegisterOpeningContainer();

  const [expanded, setExpanded] = useState(false);
  const [itemId, setItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [volume, setVolume] = useState("");
  const [count, setCount] = useState("1");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] =
    useState<OpeningContainerInput | null>(null);

  const items = useQuery({
    queryKey: ["inventory", "opening-container-items", organizationId, branchId],
    enabled: expanded && Boolean(organizationId && branchId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_items")
        .select("id,name,container_volume_ml")
        .eq("organization_id", organizationId!)
        .eq("active", true)
        .eq("may_open_for_pours", true)
        .in("tracking_method", ["volume", "both"])
        .order("name");

      if (error) throw error;
      return (data ?? []) as OpeningItem[];
    },
  });

  const stores = useQuery({
    queryKey: ["inventory", "opening-container-stores", organizationId, branchId],
    enabled: expanded && Boolean(organizationId && branchId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id,name")
        .eq("organization_id", organizationId!)
        .eq("branch_id", branchId!)
        .eq("active", true)
        .order("name");

      if (error) throw error;
      return (data ?? []) as Store[];
    },
  });

  const selectedItem = items.data?.find((item) => item.id === itemId);
  const capacity = Number(selectedItem?.container_volume_ml ?? 0);
  const locked = register.isPending || attempt !== null;

  async function submit() {
    setError("");

    if (!organizationId || !branchId) {
      setError("Select a specific property before recording opening stock.");
      return;
    }

    let input = attempt;

    if (!input) {
      const ml = Number(volume);
      const containers = Number(count);
      const remainingValue = value.trim() === "" ? null : Number(value);

      if (!selectedItem || !stores.data?.some((s) => s.id === locationId)) {
        setError("Select an eligible stock item and destination store.");
        return;
      }

      if (
        !Number.isFinite(ml) ||
        ml <= 0 ||
        !Number.isSafeInteger(containers) ||
        containers <= 0 ||
        capacity <= 0 ||
        ml > capacity * containers
      ) {
        setError("Measured volume must be positive and within container capacity.");
        return;
      }

      if (
        remainingValue !== null &&
        (!Number.isFinite(remainingValue) || remainingValue < 0)
      ) {
        setError("Enter a valid remaining inventory value.");
        return;
      }

      if (reason.trim().length < 3) {
        setError("Provide an opening-stock reference or explanation.");
        return;
      }

      input = {
        stockItemId: itemId,
        locationId,
        remainingMl: ml,
        containerCount: containers,
        remainingValue,
        reference: newOpeningContainerReference(),
        reason: reason.trim(),
      };

      setAttempt(input);
    }

    try {
      await register.mutateAsync(input);
      setAttempt(null);
      setVolume("");
      setCount("1");
      setValue("");
      setReason("");
    } catch {
      setError(
        "Registration was not confirmed. Retry the same submission to avoid duplicate stock.",
      );
    }
  }

  return (
    <section className="rounded-lg border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Existing open bottle stock</h3>
          <p className="text-sm text-muted-foreground">
            Register measured opening volume without deducting sealed bottles.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? "Close" : "Register existing open stock"}
        </Button>
      </div>

      {expanded && (
        <div className="space-y-3">
          {!branchId && (
            <p className="text-sm text-destructive">
              Select a specific property to continue.
            </p>
          )}

          {(items.error || stores.error) && (
            <p className="text-sm text-destructive">
              Could not load eligible inventory records.
            </p>
          )}

          <fieldset disabled={locked || !branchId} className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>Stock item</span>
              <select
                className="w-full rounded-md border bg-background p-2"
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
              >
                <option value="">Select item</option>
                {items.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.container_volume_ml} ml)
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span>Destination store</span>
              <select
                className="w-full rounded-md border bg-background p-2"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">Select store</option>
                {stores.data?.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span>Already-open containers</span>
              <Input
                type="number"
                min="1"
                step="1"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>Total remaining volume (ml)</span>
              <Input
                type="number"
                min="0.01"
                step="any"
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>Remaining inventory value</span>
              <Input
                type="number"
                min="0"
                step="any"
                value={value}
                placeholder="Leave blank if unverified"
                onChange={(e) => setValue(e.target.value)}
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>Opening stock explanation</span>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </fieldset>

          <p className="text-xs text-muted-foreground">
            Record only stock not previously introduced into NEØ.
            Unknown valuation requires financial reconciliation.
          </p>

          {error && (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          )}

          <Button
            type="button"
            disabled={
              register.isPending ||
              !branchId ||
              items.isLoading ||
              stores.isLoading
            }
            onClick={() => void submit()}
          >
            {register.isPending
              ? "Recording..."
              : attempt
                ? "Retry same registration"
                : "Register opening volume"}
          </Button>
        </div>
      )}
    </section>
  );
}
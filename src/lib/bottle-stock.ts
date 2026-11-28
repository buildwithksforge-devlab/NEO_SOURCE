/**
 * Sealed containers and open volume.
 *
 * Beverages tracked as "both" hold two separate balances: unopened containers
 * in `stock_levels`, and the millilitres left in an open container in
 * `stock_open_containers`. Nothing here does arithmetic on stock — the
 * database functions `inventory_open_container`, `inventory_consume_volume`
 * and `inventory_record_usage` own every balance change, so POS, delivery,
 * events and manual issues cannot disagree.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export type OpenContainerRow = {
  id: string;
  stock_item_id: string;
  location_id: string;
  open_volume_ml: number;
  containers_open: number;
  last_opened_at: string | null;
  stock_items: { name: string; container_volume_ml: number | null; default_pour_ml: number | null } | null;
  stock_locations: { name: string } | null;
};

export type ContainerEventRow = {
  id: string;
  event_type: string;
  containers_delta: number;
  volume_delta_ml: number;
  open_volume_after_ml: number;
  reason_code: string | null;
  reason: string | null;
  reference_type: string | null;
  created_at: string;
  stock_items: { name: string } | null;
  stock_locations: { name: string } | null;
};

/** Reasons a stock movement may be recorded outside a menu sale. */
export const USAGE_REASONS = [
  { value: "requisition", label: "Bar requisition" },
  { value: "breakage", label: "Breakage" },
  { value: "spillage", label: "Spillage" },
  { value: "complimentary", label: "Complimentary drink" },
  { value: "staff-consumption", label: "Staff consumption" },
  { value: "expiry", label: "Expired product" },
  { value: "event-consumption", label: "Event consumption" },
  { value: "manual-issue", label: "Manual stock issue" },
  { value: "count-variance", label: "Closing-count variance" },
] as const;

function useCtx() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return { organizationId, branchId: branchId ?? null };
}

export function useOpenContainers() {
  const { organizationId, branchId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "open-containers", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("stock_open_containers")
        .select(
          "id, stock_item_id, location_id, open_volume_ml, containers_open, last_opened_at, stock_items(name, container_volume_ml, default_pour_ml), stock_locations(name)",
        )
        .gt("open_volume_ml", 0)
        .order("last_opened_at", { ascending: false });
      q = q.eq("organization_id", organizationId!);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as OpenContainerRow[];
    },
  });
}

/**
 * Every open-container record, including bottles poured down to nothing.
 * The store view needs the empties too: a bottle standing at 0 ml is still a
 * fact about that store, and hiding it makes a balance look absent rather
 * than finished.
 */
export function useAllOpenContainers() {
  const { organizationId, branchId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "open-containers", "all", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("stock_open_containers")
        .select(
          "id, stock_item_id, location_id, open_volume_ml, containers_open, last_opened_at, stock_items(name, container_volume_ml, default_pour_ml), stock_locations(name)",
        )
        .order("last_opened_at", { ascending: false });
      q = q.eq("organization_id", organizationId!);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as OpenContainerRow[];
    },
  });
}



export function useContainerEvents(limit = 40) {
  const { organizationId, branchId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "container-events", organizationId, branchId, limit],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("stock_container_events")
        .select(
          "id, event_type, containers_delta, volume_delta_ml, open_volume_after_ml, reason_code, reason, reference_type, created_at, stock_items(name), stock_locations(name)",
        )
        .order("created_at", { ascending: false })
        .limit(limit);
      q = q.eq("organization_id", organizationId!);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ContainerEventRow[];
    },
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      ["inventory", "open-containers"],
      ["inventory", "container-events"],
      ["inventory", "movements"],
      ["inventory", "levels"],
      ["inventory", "metrics"],
    ]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  };
}


export type OpeningContainerInput = {
  stockItemId: string;
  locationId: string;
  remainingMl: number;
  containerCount: number;
  remainingValue: number | null;
  reference: string;
  reason: string;
};

export function newOpeningContainerReference(): string {
  return crypto.randomUUID();
}

export function useRegisterOpeningContainer() {
  const invalidate = useInvalidate();
  const { organizationId } = useCtx();

  return useMutation({
    mutationFn: async (input: OpeningContainerInput) => {
      if (!organizationId) {
        throw new Error("Organization required.");
      }

      if (!input.stockItemId || !input.locationId || !input.reference) {
        throw new Error("Stock item, store and registration reference are required.");
      }

      if (!Number.isFinite(input.remainingMl) || input.remainingMl <= 0) {
        throw new Error("Enter a positive remaining volume in millilitres.");
      }

      if (!Number.isSafeInteger(input.containerCount) || input.containerCount <= 0) {
        throw new Error("Enter a valid number of already-open containers.");
      }

      if (
        input.remainingValue !== null &&
        (!Number.isFinite(input.remainingValue) || input.remainingValue < 0)
      ) {
        throw new Error("Enter a valid remaining inventory value.");
      }

      if (input.reason.trim().length < 3) {
        throw new Error("An opening-stock explanation is required.");
      }

      const { data, error } = await guardedRpc(
        supabase,
        "neo_register_opening_container",
        {
          _item: input.stockItemId,
          _location: input.locationId,
          _remaining_ml: input.remainingMl,
          _container_count: input.containerCount,
          _remaining_value: input.remainingValue,
          _reference: input.reference,
          _reason: input.reason.trim(),
        } as never
      );

      if (error) throw new Error(error.message);

      const result = data as unknown as Record<string, unknown> | null;

      if (
        !result ||
        result['ok'] !== true ||
        typeof result['event_id'] !== "string" ||
        !["registered", "already-recorded"].includes(String(result['status']))
      ) {
        throw new Error("Opening-stock registration was not confirmed.");
      }

      return result;
    },

    onSuccess: (result) => {
      invalidate();

      if (result['status'] === "already-recorded") {
        toast.info("Opening volume was already registered.");
      } else {
        toast.success("Existing open stock registered", {
          description:
            result['valuation_status'] === "unverified"
              ? "Volume recorded. Inventory valuation requires review."
              : "Open volume recorded without deducting a sealed bottle.",
        });
      }
    },

    onError: (error: Error) => {
      toast.error("Opening-stock registration failed", {
        description: error.message,
      });
    },
  });
}

export function useOpenBottle() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { stockItemId: string; locationId: string; reason?: string }) => {
      const { data, error } = await guardedRpc(supabase, "inventory_open_container", {
        _item: input.stockItemId,
        _location: input.locationId,
        _reason: input.reason ?? null,
        _reference_type: "bar_bottle_open",
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Bottle opened", {
        description: "One sealed container moved into open volume.",
      });
    },
    onError: (e: Error) => toast.error("Could not open the bottle", { description: e.message }),
  });
}

export function useRecordUsage() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      stockItemId: string;
      locationId: string;
      quantity: number;
      unit: string;
      reasonCode: string;
      reason: string;
    }) => {
      const { data, error } = await guardedRpc(supabase, "inventory_record_usage", {
        _item: input.stockItemId,
        _location: input.locationId,
        _quantity: input.quantity,
        _unit: input.unit,
        _reason_code: input.reasonCode,
        _reason: input.reason,
        _reference_type: "manual_usage",
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Usage recorded", { description: "The stock ledger has been updated." });
    },
    onError: (e: Error) => toast.error("Could not record the usage", { description: e.message }),
  });
}

export function formatMl(value: number | null | undefined) {
  const n = Number(value ?? 0);
  if (n >= 1000) return `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} L`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ml`;
}

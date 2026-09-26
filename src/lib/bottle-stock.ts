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
  { value: "transfer", label: "Transfer to another store" },
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

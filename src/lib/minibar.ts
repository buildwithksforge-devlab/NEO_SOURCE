/**
 * Minibar.
 *
 * A minibar consumption is two things happening together: the item leaves the
 * minibar store, and the guest's open folio is charged for it. Both happen in
 * one server routine so neither can happen without the other, and posting the
 * same consumption twice charges once.
 *
 * Nothing here invents a price, a store or a stock mapping: a line can only be
 * posted when the menu item is mapped to a stock item and carries a price.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export type MinibarLine = {
  menu_item_id: string;
  description: string;
  quantity: number;
  unit_price: number;
};

/** Folios that can still be charged, with the guest and room where known. */
export function useChargeableFolios() {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["minibar", "folios", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("folios")
          .select(
            "id, folio_number, folio_type, status, balance, reservation_id, customers(full_name), reservations(id, room_id, rooms(room_number))",
          ),
        "folios",
      )
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

/** Menu items that deduct a stock item directly — the sellable minibar list. */
export function useMinibarMenuItems() {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["minibar", "menu", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("menu_items")
          .select(
            "id, name, base_price, consumption_mode, consumption_channels, stock_item_id, stock_quantity_per_sale, stock_unit",
          ),
        "menu_items",
      )
        .in("consumption_mode", ["direct_stock", "batch"])
        .not("stock_item_id", "is", null)
        .order("name")
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

/** Minibar consumptions already posted, newest first. */
export function useMinibarPostings() {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["minibar", "postings", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("minibar_postings" as never)
          .select(
            "id, posting_number, posted_at, total_amount, notes, folio_id, room_id, location_id, minibar_posting_lines(id, description, quantity, unit, unit_price, amount)",
          ),
        "minibar_postings",
      )
        .order("posted_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

const POST_REASONS: Record<string, string> = {
  folio_not_found: "That folio no longer exists.",
  forbidden: "That folio belongs to another property.",
  not_permitted: "You do not have permission to charge a folio.",
  folio_not_open: "That folio is closed, so it cannot be charged.",
  location_not_found: "Choose a minibar store that belongs to this property.",
  no_lines: "Add at least one item before posting.",
};

/** Take the items out of the minibar store and charge them to the folio. */
export function usePostMinibar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      folioId: string;
      locationId: string;
      roomId?: string | null;
      notes?: string | null;
      lines: MinibarLine[];
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_minibar_post", {
        _folio: input.folioId,
        _location: input.locationId,
        _lines: input.lines,
        _room: input.roomId ?? null,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { ok?: boolean; reason?: string; posting_number?: string };
      if (result.ok !== true) {
        throw new Error(POST_REASONS[result.reason ?? ""] ?? "That minibar charge could not be posted.");
      }
      return result;
    },
    onSuccess: (result) => {
      toast.success(`Minibar charge ${result.posting_number ?? ""} posted to the folio.`.trim());
      void qc.invalidateQueries({ queryKey: ["minibar"] });
      void qc.invalidateQueries({ queryKey: ["pms"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

import { guardedRpc } from "@/lib/rpc-guard";
import { useScopedRealtime } from "@/lib/realtime-scope";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { useDataScope } from "@/lib/data-scope";
import { DEFAULT_KITCHEN_SETTINGS, nextRequestNumber, type KitchenSettings, type Row } from "@/lib/kitchen";
import { useScopedWorkerOptions } from "@/lib/scoped-options";
import { bindMenuItemConsumption } from "@/lib/recipe-master";

const sel = (s: string): string => s;

function useCtx() {
  const { organizationId, user } = useAuth();
  const branchId = useWriteBranchId();
  return {
    organizationId,
    organization_id: organizationId as string,
    branch_id: branchId,
    userId: user?.id ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Stations, routing and settings
 * ------------------------------------------------------------------ */

export function useKitchenStations() {
  const { organizationId } = useCtx();
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "stations", organizationId, branchId ?? "all", filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("operational_stations")
        .select(sel("id, name, code, station_type, department_id, branch_id, supervisor_user_id, status, active, sort_order"))
        .eq("active", true)
        .order("sort_order")
        .order("name");
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useMyStations() {
  const { organizationId, userId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "my-stations", organizationId, userId],
    enabled: Boolean(organizationId && userId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_stations")
        .select(sel("station_id, is_primary, operational_stations(id, name, code, station_type)"))
        .eq("user_id", userId as string);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useRoutingRules() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "routing-rules", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("station_routing_rules")
        .select(sel("*, operational_stations!station_routing_rules_station_id_fkey(name), menu_items(name), menu_categories(name)"))
        .order("priority");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSaveRoutingRule() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (rule: Record<string, unknown>) => {
      const payload = { ...rule, organization_id: ctx.organization_id, created_by: ctx.userId };
      const { error } = await supabase.from("station_routing_rules").upsert(payload as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Routing rule saved.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "routing-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteRoutingRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("station_routing_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Routing rule removed.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "routing-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useKitchenSettings() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "settings", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<{ id: string | null; settings: KitchenSettings }> => {
      const { data, error } = await supabase
        .from("kitchen_settings")
        .select(sel("id, settings"))
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const row = data as { id: string; settings: Partial<KitchenSettings> } | null;
      return {
        id: row?.id ?? null,
        settings: { ...DEFAULT_KITCHEN_SETTINGS, ...(row?.settings ?? {}) },
      };
    },
  });
}

export function useSaveKitchenSettings() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async ({ id, settings }: { id: string | null; settings: KitchenSettings }) => {
      const payload = {
        ...(id ? { id } : {}),
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        settings,
      };
      const { error } = await supabase.from("kitchen_settings").upsert(payload as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Kitchen settings saved.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePreparationTargets() {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "prep-targets", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("preparation_targets")
          .select(sel("*, operational_stations(name), menu_items(name)")),
        "preparation_targets",
      )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSavePreparationTarget() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (target: Record<string, unknown>) => {
      const { error } = await supabase
        .from("preparation_targets")
        .upsert({ ...target, organization_id: ctx.organization_id, created_by: ctx.userId } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Preparation target saved.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "prep-targets"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Live queue — reuses Phase 7 station_tickets / station_ticket_items
 * ------------------------------------------------------------------ */

const TICKET_SELECT = sel(
  "*, operational_stations(id, name, code), pos_orders(id, order_number, order_type, guest_name, guest_count, dietary_notes, allergy_alert, waiter_id, room_id, table_id, restaurant_tables(code)), station_ticket_items(*, pos_order_items(id, item_name, quantity, course, special_instructions, allergy_note, status, menu_item_id, pos_order_item_modifiers(option_name, group_name)))",
);

export function useKitchenQueue(stationId: string | "all", statuses?: string[]) {
  // Station/self scope keeps a line chef on their own station's tickets; a
  // kitchen manager sees the department, a superuser the organisation.
  const { applyScope, scopeKey } = useDataScope();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "queue", organizationId, stationId, statuses?.join(",") ?? "live", scopeKey],
    enabled: Boolean(organizationId),
    refetchInterval: 20_000,
    queryFn: async () => {
      let q = applyScope(supabase.from("station_tickets").select(TICKET_SELECT), "station_tickets").order("received_at");
      if (stationId !== "all") q = q.eq("station_id", stationId);
      if (statuses?.length) q = q.in("status", statuses);
      else q = q.not("status", "in", "(cancelled,completed,served)");
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useTicketHistory(ticketId?: string) {
  return useQuery({
    queryKey: ["kitchen", "ticket-history", ticketId],
    enabled: Boolean(ticketId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("station_ticket_status_history")
        .select(sel("*"))
        .eq("ticket_id", ticketId as string)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

/** Server-enforced item transition — the database validates the move and rolls the ticket up. */
export function useItemTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, status, reason }: { itemId: string; status: string; reason?: string }) => {
      const { data, error } = await guardedRpc(supabase, "kitchen_item_transition", {
        _ticket_item_id: itemId,
        _to_status: status,
        ...(reason ? { _reason: reason } : {}),
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReportTicketDelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ticketId, reason }: { ticketId: string; reason: string }) => {
      const { error } = await supabase
        .from("station_tickets")
        .update({ status: "delayed", delay_reason: reason } as never)
        .eq("id", ticketId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Delay recorded and escalated.");
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePrioritizeTicket() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async ({ ticketId, priority, reason }: { ticketId: string; priority: string; reason: string }) => {
      const { error } = await supabase
        .from("station_tickets")
        .update({ priority, priority_reason: reason, prioritized_by: ctx.userId } as never)
        .eq("id", ticketId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Ticket priority updated.");
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Allocation of kitchen work. This goes through `neo_kitchen_assign_chef`,
 * which is the one routine permitted to touch the allocation columns: it
 * checks the explicit allocation permission, moves the ticket and its open
 * items together, and writes the assignment audit row. Writing the three
 * tables from the client instead would leave a half-assigned ticket behind
 * whenever one of the writes was refused.
 */
export function useAssignChef() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ticketId,
      ticketItemId,
      chefId,
      reason,
    }: {
      ticketId?: string;
      ticketItemId?: string;
      chefId: string;
      stationId?: string | null;
      method?: string;
      reason?: string;
    }) => {
      if (!ticketId) throw new Error("A kitchen order is required to assign a chef.");
      const { error } = await guardedRpc(supabase, "neo_kitchen_assign_chef", {
        _ticket: ticketId,
        _chef: chefId,
        _item: ticketItemId ?? null,
        _reason: reason ?? null,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Chef assigned.");
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export function useReassignStation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ticketId, stationId, reason }: { ticketId: string; stationId: string; reason: string }) => {
      const { error } = await supabase
        .from("station_tickets")
        .update({ station_id: stationId, routing_note: reason } as never)
        .eq("id", ticketId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Ticket moved to another station.");
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useClarifications(status?: string) {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "clarifications", organizationId, status ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase.from("ticket_clarifications").select(sel("*")).order("created_at", { ascending: false });
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useAskClarification() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async ({
      ticketId,
      ticketItemId,
      orderItemId,
      question,
    }: {
      ticketId: string;
      ticketItemId: string;
      orderItemId?: string | null;
      question: string;
    }) => {
      const { error } = await supabase.from("ticket_clarifications").insert({
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        ticket_id: ticketId,
        ticket_item_id: ticketItemId,
        order_item_id: orderItemId ?? null,
        question,
        asked_by: ctx.userId,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Clarification sent to the service team.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "clarifications"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAnswerClarification() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async ({ id, answer }: { id: string; answer: string }) => {
      const { error } = await supabase
        .from("ticket_clarifications")
        .update({
          answer,
          answered_by: ctx.userId,
          answered_at: new Date().toISOString(),
          status: "answered",
        } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Response sent to the kitchen.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "clarifications"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Recipes, portions, batches
 * ------------------------------------------------------------------ */

export function useRecipes() {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "recipes", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("recipes").select(sel("*, menu_items(name), operational_stations(name), recipe_ingredients!recipe_ingredients_recipe_id_fkey(*)")),
        "recipes",
      )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSaveRecipe() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (recipe: Record<string, unknown>) => {
      const { error } = await supabase
        .from("recipes")
        .upsert({ ...recipe, organization_id: ctx.organization_id, created_by: ctx.userId } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Recipe saved.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "recipes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Approving activates a new version; the previous active version is superseded, never rewritten. */
export function useApproveRecipe() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async ({ recipeId, menuItemId }: { recipeId: string; menuItemId: string }) => {
      const { error: supErr } = await supabase
        .from("recipes")
        .update({ status: "superseded" } as never)
        .eq("menu_item_id", menuItemId)
        .eq("status", "active");
      if (supErr) throw supErr;
      const { error } = await supabase
        .from("recipes")
        .update({
          status: "active",
          approved_by: ctx.userId,
          approved_at: new Date().toISOString(),
        } as never)
        .eq("id", recipeId);
      if (error) throw error;
      // Approval is the moment the recipe becomes the menu item's way of
      // consuming stock — the item is bound here, never by a separate step.
      const { data: recipe } = await supabase
        .from("recipes")
        .select("recipe_type, output_stock_item_id")
        .eq("id", recipeId)
        .maybeSingle();
      const recipeType = String((recipe as Record<string, unknown> | null)?.["recipe_type"] ?? "menu_item");
      await bindMenuItemConsumption(
        menuItemId,
        recipeType === "direct_sale" ? "direct_sale" : "menu_item",
        (recipe as Record<string, unknown> | null)?.["output_stock_item_id"] as string | null,
      );
    },
    onSuccess: () => {
      toast.success("Recipe version approved and activated.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "recipes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecipeIngredientMutation() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const { error } = await supabase
        .from("recipe_ingredients")
        .upsert({ ...row, organization_id: ctx.organization_id } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kitchen", "recipes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePortionStandards() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "portions", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("portion_standards")
        .select(sel("*, menu_items(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSavePortionStandard() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const { error } = await supabase
        .from("portion_standards")
        .upsert({ ...row, organization_id: ctx.organization_id, created_by: ctx.userId } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Portion standard saved.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "portions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useProductionBatches() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "batches", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_batches")
        .select(sel("*, operational_stations(name), recipes(version, menu_items(name))"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSaveBatch() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const payload = {
        batch_number: nextRequestNumber("BATCH"),
        ...row,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        created_by: ctx.userId,
      };
      const { error } = await supabase.from("production_batches").upsert(payload as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Production batch saved.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "batches"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Reasons the server can refuse to post a batch, said plainly. */
const BATCH_POST_REASONS: Record<string, string> = {
  not_found: "That batch no longer exists.",
  forbidden: "That batch belongs to another property.",
  not_permitted: "You do not have permission to post production to stock.",
  no_actual_quantity: "Record how much was actually produced before posting.",
  no_recipe: "This batch has no recipe, so its ingredients are unknown.",
  no_output_stock_item:
    "The recipe has no produced stock item, so there is nothing to receive into the store.",
  bad_yield: "The recipe has no yield quantity, so the ingredients cannot be scaled.",
  no_location: "No kitchen store is set for this station. Choose a store first.",
};

/**
 * Post a completed batch to stock: ingredients out of the store, the produced
 * item in, waste written off. Posting twice does nothing the second time.
 */
export function usePostProductionBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { batchId: string; locationId?: string | null }) => {
      const { data, error } = await guardedRpc(supabase, "neo_production_batch_post", {
        _batch: input.batchId,
        _location: input.locationId ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { ok?: boolean; reason?: string };
      if (result.ok !== true) {
        throw new Error(BATCH_POST_REASONS[result.reason ?? ""] ?? "That batch could not be posted.");
      }
      return result as { ok: true; reason?: string; ingredient_lines?: number; produced?: number };
    },
    onSuccess: (result) => {
      toast.success(
        result.reason === "already_posted"
          ? "This batch was already posted to stock."
          : `Posted to stock — ${result.ingredient_lines ?? 0} ingredient${result.ingredient_lines === 1 ? "" : "s"} used.`,
      );
      void qc.invalidateQueries({ queryKey: ["kitchen", "batches"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Stores requests, shortages, waste, quality, equipment
 * ------------------------------------------------------------------ */

export function useIngredientRequests() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "requests", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kitchen_ingredient_requests")
        .select(sel("*, operational_stations(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSaveIngredientRequest() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const payload = {
        request_number: nextRequestNumber("KR"),
        ...row,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        requested_by: ctx.userId,
      };
      const { error } = await supabase.from("kitchen_ingredient_requests").upsert(payload as never);
      if (error) throw error;

      // The kitchen's own list is only half the story: the request has to land
      // on the Stores desk as a real requisition, otherwise nobody can issue
      // against it. The ingredient is matched to a stock item by exact name
      // when one exists; otherwise Stores sees the written description.
      if (!ctx.branch_id) throw new Error("Select a property before sending a request to Stores");
      const name = String(row["ingredient_name"] ?? "").trim();
      const quantity = Number(row["quantity"] ?? 0);
      if (!name || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Give the ingredient and a quantity above zero");
      }
      const { data: match } = await supabase
        .from("stock_items")
        .select("id")
        .eq("organization_id", ctx.organization_id)
        .ilike("name", name)
        .limit(1)
        .maybeSingle();

      const { data: req, error: reqError } = await guardedRpc(
        supabase,
        "neo_department_requisition_create",
        {
          _branch: ctx.branch_id,
          _lines: [
            {
              stock_item_id: (match as Row | null)?.["id"] ?? null,
              description: name,
              unit: String(row["unit"] ?? "").trim() || null,
              quantity_requested: quantity,
              notes: String(row["reason"] ?? "").trim() || null,
            },
          ],
          _department: null,
          _required_date: null,
          _priority: String(row["priority"] ?? "normal"),
          _reason: String(row["reason"] ?? "").trim() || `Kitchen request for ${name}`,
          _destination: null,
        },
      );
      if (reqError) throw new Error(reqError.message);
      return (req ?? {}) as Row;
    },
    onSuccess: (data) => {
      const number = String((data as Row)?.["request_number"] ?? "");
      toast.success(number ? `Request sent to Stores as ${number}` : "Request sent to Stores.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "requests"] });
      void qc.invalidateQueries({ queryKey: ["fnb"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export function useUpdateRequestStatus() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: string; note?: string }) => {
      const { error } = await supabase
        .from("kitchen_ingredient_requests")
        .update({ status, stores_note: note ?? null, handled_by: ctx.userId } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kitchen", "requests"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useShortageAlerts() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "shortages", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ingredient_shortage_alerts")
        .select(sel("*, operational_stations(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useReportShortage() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const { error } = await supabase.from("ingredient_shortage_alerts").insert({
        ...row,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        reported_by: ctx.userId,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Shortage reported to Stores and the Kitchen Manager.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "shortages"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useWasteRecords() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "waste", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("waste_records")
        .select(sel("*, operational_stations(name), menu_items(name)"))
        .order("occurred_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useRecordWaste() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const payload = {
        waste_number: nextRequestNumber("WST"),
        ...row,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        recorded_by: ctx.userId,
      };
      const { error } = await supabase.from("waste_records").insert(payload as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Waste record created.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "waste"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewWaste() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async ({ id, action, comment }: { id: string; action: "approved" | "rejected"; comment?: string }) => {
      const { error } = await supabase
        .from("waste_records")
        .update({
          status: action,
          reviewed_by: ctx.userId,
          reviewed_at: new Date().toISOString(),
        } as never)
        .eq("id", id);
      if (error) throw error;
      const { error: actErr } = await supabase.from("waste_approval_actions").insert({
        organization_id: ctx.organization_id,
        waste_record_id: id,
        action,
        comment: comment ?? null,
        acted_by: ctx.userId,
      } as never);
      if (actErr) throw actErr;
    },
    onSuccess: () => {
      toast.success("Waste record reviewed.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "waste"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Take an approved waste record off stock. The database decides the store, the
 * cost and whether it has already been posted — posting twice is refused there,
 * not here, so a double click cannot double-deduct.
 */
export function usePostWasteToStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, locationId }: { id: string; locationId?: string | null }) => {
      const { data, error } = await guardedRpc(supabase, "neo_kitchen_waste_post", {
        _waste: id,
        _location: locationId ?? null,
      });
      if (error) throw error;
      const result = (data ?? {}) as { ok?: boolean; reason?: string };
      if (!result.ok) throw new Error(String(result.reason ?? "Could not post this waste to stock."));
      return result;
    },
    onSuccess: (result) => {
      toast.success(
        (result as { reason?: string }).reason === "already_posted"
          ? "This waste was already taken off stock."
          : "Waste posted — stock reduced.",
      );
      void qc.invalidateQueries({ queryKey: ["kitchen", "waste"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      void qc.invalidateQueries({ queryKey: ["staff-board"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useQualityChecklists() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "checklists", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quality_checklists")
        .select(sel("*, operational_stations(name), quality_checklist_items(*)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSaveChecklist() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const { error } = await supabase
        .from("quality_checklists")
        .upsert({ ...row, organization_id: ctx.organization_id, created_by: ctx.userId } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Checklist saved.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "checklists"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useQualityChecks() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "quality-checks", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quality_check_records")
        .select(sel("*, quality_checklists(name), operational_stations(name)"))
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useRecordQualityCheck() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const { error } = await supabase.from("quality_check_records").insert({
        ...row,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        completed_by: ctx.userId,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Quality check recorded.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "quality-checks"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useQualityHolds() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "holds", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quality_holds")
        .select(sel("*, operational_stations(name), menu_items(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useCreateHold() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const { error } = await supabase.from("quality_holds").insert({
        ...row,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        created_by: ctx.userId,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Quality hold created.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "holds"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReleaseHold() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note: string }) => {
      const { error } = await supabase
        .from("quality_holds")
        .update({
          status: "released",
          released_by: ctx.userId,
          released_at: new Date().toISOString(),
          release_note: note,
        } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Hold released.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "holds"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useEquipmentIssues() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "equipment", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kitchen_equipment_issues")
        .select(sel("*, operational_stations(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

/** Reporting an equipment issue also raises a maintenance task (Phase 2 tasks reused). */
export function useReportEquipmentIssue() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const { data: task, error: taskErr } = await supabase
        .from("tasks")
        .insert({
          organization_id: ctx.organization_id,
          branch_id: ctx.branch_id,
          station_id: (row["station_id"] as string) ?? null,
          reference: nextRequestNumber("KEQ"),
          title: `Kitchen equipment: ${String(row["issue_type"] ?? "issue")}`,
          description: String(row["description"] ?? ""),
          priority: String(row["priority"] ?? "normal"),
          created_by: ctx.userId,
        } as never)
        .select("id")
        .single();
      if (taskErr) throw taskErr;
      const { error } = await supabase.from("kitchen_equipment_issues").insert({
        ...row,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        reported_by: ctx.userId,
        task_id: (task as { id: string }).id,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Equipment issue reported and a maintenance task created.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "equipment"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useKitchenHandovers() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "handovers", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kitchen_handovers")
        .select(sel("*, operational_stations(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSaveHandover() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const { error } = await supabase.from("kitchen_handovers").upsert({
        ...row,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        completed_by: ctx.userId,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Handover recorded.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "handovers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Metrics, menu availability, AI insights, realtime
 * ------------------------------------------------------------------ */

export function useKitchenMetrics(from?: string, to?: string) {
  const { organizationId, branch_id } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "metrics", organizationId, from, to],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "kitchen_metrics", {
        ...(branch_id ? { _branch: branch_id } : {}),
        _from: from ?? new Date(Date.now() - 86_400_000).toISOString(),
        _to: to ?? new Date().toISOString(),
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, number | null>;
    },
  });
}

export function useKitchenMenuItems() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "menu-items", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menu_items")
        .select(sel("id, name, availability, category_id, station_id, prep_minutes, menu_categories(name)"))
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSetMenuAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, availability }: { id: string; availability: string }) => {
      const { error } = await supabase.from("menu_items").update({ availability } as never).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Menu availability updated for the POS in real time.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "menu-items"] });
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useKitchenAiInsights() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "ai", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kitchen_ai_insights")
        .select(sel("*"))
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useKitchenStaff() {
  return useScopedWorkerOptions({ jobTitlePattern: "chef|cook|kitchen|steward" });
}

/** One realtime channel for every kitchen surface, torn down on unmount. */
export function useKitchenRealtime() {
  const qc = useQueryClient();
  useScopedRealtime("kitchen-live", [
    {
      table: "station_tickets",
      onChange: () => {
        void qc.invalidateQueries({ queryKey: ["kitchen", "queue"] });
        void qc.invalidateQueries({ queryKey: ["kitchen", "metrics"] });
      },
    },
    { table: "station_ticket_items", onChange: () => void qc.invalidateQueries({ queryKey: ["kitchen", "queue"] }) },
    {
      table: "ticket_clarifications",
      onChange: () => void qc.invalidateQueries({ queryKey: ["kitchen", "clarifications"] }),
    },
    {
      table: "ingredient_shortage_alerts",
      onChange: () => void qc.invalidateQueries({ queryKey: ["kitchen", "shortages"] }),
    },
  ]);
}

/** Realtime connection indicator for kitchen displays. */
export function useRealtimeStatus() {
  return supabase.realtime.isConnected() ? "online" : "connecting";
}

/* ------------------------------------------------------------------ *
 * Routing coverage
 *
 * An ordered item reaches a chef only when it resolves to a station.
 * The database resolves item rule -> category rule -> category station,
 * and refuses to guess when a workspace has more than one production
 * station. This hook surfaces exactly which categories are still
 * unrouted so the kitchen can configure them, instead of silently
 * printing "No Station" on live tickets.
 * ------------------------------------------------------------------ */
export function useMenuCategories() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["kitchen", "menu-categories", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menu_categories")
        .select(sel("id, name, station_id, active"))
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useRoutingCoverage() {
  const categories = useMenuCategories();
  const items = useKitchenMenuItems();
  const rules = useRoutingRules();

  const ruleRows = (rules.data ?? []) as Row[];
  const routedCategoryIds = new Set(
    ruleRows.map((r) => r["category_id"]).filter(Boolean).map(String),
  );
  const routedItemIds = new Set(
    ruleRows.map((r) => r["menu_item_id"]).filter(Boolean).map(String),
  );

  const categoryRows = (categories.data ?? []) as Row[];
  const itemRows = (items.data ?? []) as Row[];

  const unrouted = categoryRows
    .filter((c) => {
      const id = String(c["id"]);
      if (c["station_id"] || routedCategoryIds.has(id)) return false;
      // A category is only a problem when it still holds items that no
      // item-level station or item-level rule already covers.
      return itemRows.some(
        (i) =>
          String(i["category_id"] ?? "") === id &&
          !i["station_id"] &&
          !routedItemIds.has(String(i["id"])),
      );
    })
    .map((c) => ({
      id: String(c["id"]),
      name: String(c["name"] ?? "Category"),
      items: itemRows.filter(
        (i) =>
          String(i["category_id"] ?? "") === String(c["id"]) &&
          !i["station_id"] &&
          !routedItemIds.has(String(i["id"])),
      ).length,
    }));

  const orphanItems = itemRows.filter(
    (i) => !i["station_id"] && !i["category_id"] && !routedItemIds.has(String(i["id"])),
  ).length;

  return {
    isLoading: categories.isLoading || items.isLoading || rules.isLoading,
    error: categories.error ?? items.error ?? rules.error,
    unrouted,
    orphanItems,
    totalItems: itemRows.length,
  };
}

/* ------------------------------------------------------------------ *
 * Consumption stores per station
 *
 * A sold dish only deducts stock when its station resolves to a stock
 * location. Without that binding the recipe engine returns "no-location"
 * and the sale leaves the store untouched — which is why a ticket could
 * post a zero-value consumption line. These read and write the binding
 * itself; nothing is guessed on the workspace's behalf.
 * ------------------------------------------------------------------ */

export type StationStoreRow = {
  station_id: string;
  station_name: string;
  station_type: string;
  department_name: string | null;
  branch_id: string | null;
  recipes_active: number;
  direct_items: number;
  location_id: string | null;
  location_name: string | null;
  mapped_explicitly: boolean;
  ready: boolean;
};

/**
 * Every outlet that prepares something — grill, hot kitchen, coffee station,
 * bar — needs its own supply store for the selected property. This reads the
 * same resolver the consumption service uses, so the screen and the deduction
 * can never disagree.
 */
export function useStationStoreReadiness() {
  const { organizationId } = useCtx();
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "station-stores", organizationId, branchId ?? "all", filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase as never, "neo_station_store_readiness", {
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as unknown as Row[]).map((r) => ({
        station_id: String(r["station_id"]),
        station_name: String(r["station_name"] ?? "Station"),
        station_type: String(r["station_type"] ?? "service"),
        department_name: (r["department_name"] as string | null) ?? null,
        branch_id: (r["branch_id"] as string | null) ?? null,
        recipes_active: Number(r["recipes_active"] ?? 0),
        direct_items: Number(r["direct_items"] ?? 0),
        location_id: (r["location_id"] as string | null) ?? null,
        location_name: (r["location_name"] as string | null) ?? null,
        mapped_explicitly: Boolean(r["mapped_explicitly"]),
        ready: Boolean(r["ready"]),
      })) as StationStoreRow[];
    },
  });
}

export function useConsumptionStores() {
  const { organizationId } = useCtx();
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "consumption-stores", organizationId, branchId ?? "all", filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("stock_locations")
        .select(sel("id, name, code, location_type, branch_id, station_id, active"))
        .eq("active", true)
        .order("name");
      if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

/**
 * Binds one stock location to the station that consumes from it, per property,
 * through the explicit mapping table the consumption resolver reads first. Two
 * outlets may share a store; the mapping is per station, not per store.
 */
export function useAssignStationStore() {
  const qc = useQueryClient();
  const { organizationId } = useCtx();
  return useMutation({
    mutationFn: async ({
      stationId,
      locationId,
      branchId,
    }: {
      stationId: string;
      locationId: string;
      branchId?: string | null;
    }) => {
      const { error } = await supabase.from("station_consumption_stores").upsert(
        {
          organization_id: organizationId,
          station_id: stationId,
          location_id: locationId,
          branch_id: branchId ?? null,
        } as never,
        { onConflict: "station_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Supply store set for this station.");
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


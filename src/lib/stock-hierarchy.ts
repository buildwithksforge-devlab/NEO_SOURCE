/**
 * Item Group → Category → Stock Item.
 *
 * The catalogue has three levels, not two. An item group is a classification,
 * never a physical location: the store attached to a group is only a *fallback*
 * used when a stock item has no default store of its own. Milk may live in the
 * chiller and flour in the dry store while both stay in Food / Dry Goods.
 *
 * Routing precedence, mirrored by `neo_stock_resolve_location` in the database:
 *   1. the store explicitly chosen on the transaction
 *   2. the stock item's own default store
 *   3. the item group's fallback store
 *   4. otherwise nothing — the person is asked to choose a store
 *
 * Nothing here ever assigns an existing category to a group on its own. The
 * database can *propose* a group from the category name; the proposal only
 * becomes real when a person with stock-catalogue rights confirms it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

export type ItemGroup = {
  id: string;
  name: string;
  code: string | null;
  kind: string;
  sortOrder: number;
  active: boolean;
};

export type CategoryRow = {
  id: string;
  name: string;
  code: string | null;
  groupId: string | null;
  proposedGroupId: string | null;
  proposedReason: string | null;
  confirmedAt: string | null;
};

export type GroupStore = {
  id: string;
  groupId: string;
  branchId: string | null;
  locationId: string;
};

const KEY = "stock-hierarchy";

export function useItemGroups() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "groups", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<ItemGroup[]> => {
      const { data, error } = await db
        .from("stock_item_groups")
        .select("id, name, code, kind, sort_order, active")
        .order("sort_order");
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        code: r.code ?? null,
        kind: r.kind,
        sortOrder: Number(r.sort_order ?? 0),
        active: Boolean(r.active),
      }));
    },
  });
}

export function useStockCategories() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "categories", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<CategoryRow[]> => {
      const { data, error } = await db
        .from("stock_categories")
        .select("id, name, code, group_id, proposed_group_id, proposed_reason, group_confirmed_at")
        .order("name");
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        code: r.code ?? null,
        groupId: r.group_id ?? null,
        proposedGroupId: r.proposed_group_id ?? null,
        proposedReason: r.proposed_reason ?? null,
        confirmedAt: r.group_confirmed_at ?? null,
      }));
    },
  });
}

export function useStoreLocations(branchId?: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "locations", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("stock_locations")
        .select("id, name, location_type, branch_id, active")
        .eq("active", true)
        .order("name");
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{
        id: string;
        name: string;
        location_type: string;
        branch_id: string | null;
      }>;
    },
  });
}

export function useGroupStores() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "group-stores", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<GroupStore[]> => {
      const { data, error } = await db
        .from("stock_group_stores")
        .select("id, group_id, branch_id, location_id");
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: any) => ({
        id: r.id,
        groupId: r.group_id,
        branchId: r.branch_id ?? null,
        locationId: r.location_id,
      }));
    },
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: [KEY] });
}

/** Create the standard seven groups. Existing names are never overwritten. */
export function useSeedItemGroups() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const { data, error } = await guardedRpc(db, "neo_stock_seed_item_groups", {});
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },
    onSuccess: invalidate,
  });
}

/** Draft only: fills in a suggested group for unmapped categories. */
export function useProposeGroupMapping() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const { data, error } = await guardedRpc(db, "neo_stock_propose_group_mapping", {});
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },
    onSuccess: invalidate,
  });
}

/** Apply one category's group. Passing no group clears the assignment. */
export function useConfirmGroupMapping() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { categoryId: string; groupId?: string | null }) => {
      const { data, error } = await guardedRpc(db, "neo_stock_confirm_group_mapping", {
        _category: input.categoryId,
        _group: input.groupId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string | null;
    },
    onSuccess: invalidate,
  });
}

/** One default physical store per group, per property. */
export function useSetGroupStore() {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      groupId: string;
      branchId: string | null;
      locationId: string | null;
    }) => {
      const match = db
        .from("stock_group_stores")
        .delete()
        .eq("group_id", input.groupId)
        .is("branch_id", input.branchId === null ? null : undefined);
      if (input.branchId === null) {
        const { error } = await match;
        if (error) throw new Error(error.message);
      } else {
        const { error } = await db
          .from("stock_group_stores")
          .delete()
          .eq("group_id", input.groupId)
          .eq("branch_id", input.branchId);
        if (error) throw new Error(error.message);
      }
      if (!input.locationId) return null;
      const { error } = await db.from("stock_group_stores").insert({
        organization_id: organizationId,
        group_id: input.groupId,
        branch_id: input.branchId,
        location_id: input.locationId,
      });
      if (error) throw new Error(error.message);
      return input.locationId;
    },
    onSuccess: invalidate,
  });
}

/** The group's fallback store for a category, if one is configured. */
export function resolveStoreForCategory(
  categoryId: string | null | undefined,
  categories: CategoryRow[],
  groupStores: GroupStore[],
  branchId: string | null,
): string | null {
  if (!categoryId) return null;
  const groupId = categories.find((c) => c.id === categoryId)?.groupId ?? null;
  if (!groupId) return null;
  const scoped = groupStores.find((s) => s.groupId === groupId && s.branchId === branchId);
  const fallback = groupStores.find((s) => s.groupId === groupId && s.branchId === null);
  return scoped?.locationId ?? fallback?.locationId ?? null;
}

/**
 * Where one stock item's movement should land: the store chosen on the
 * transaction, then the item's own default store, then the group's fallback
 * store. `null` means the person must pick a store — never guess.
 */
export function resolveStoreForItem(input: {
  explicitLocationId?: string | null;
  defaultLocationId?: string | null;
  categoryId?: string | null;
  categories: CategoryRow[];
  groupStores: GroupStore[];
  branchId: string | null;
}): string | null {
  return (
    input.explicitLocationId ??
    input.defaultLocationId ??
    resolveStoreForCategory(input.categoryId, input.categories, input.groupStores, input.branchId)
  );
}

/** Plain-language readiness, used to say honestly whether routing can work. */
export function hierarchyReadiness(groups: ItemGroup[], categories: CategoryRow[], stores: GroupStore[]) {
  const mapped = categories.filter((c) => c.groupId).length;
  const proposed = categories.filter((c) => !c.groupId && c.proposedGroupId).length;
  const groupsWithStore = new Set(stores.map((s) => s.groupId)).size;
  return {
    groups: groups.length,
    categories: categories.length,
    mapped,
    proposed,
    unmapped: categories.length - mapped,
    groupsWithStore,
    ready: groups.length > 0 && categories.length > 0 && mapped === categories.length && groupsWithStore === groups.length,
  };
}

/**
 * The three-level catalogue, made explicit and finishable.
 *
 * Item group is the top level and carries a fallback store, used only when a
 * stock item has no default store of its own. Classification never restricts
 * where an item may hold stock. Existing categories are never moved on their
 * own: the system may suggest a group from the name, and a person with
 * stock-catalogue rights decides whether that suggestion stands.
 */
import { SectionCard } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useWriteBranchId } from "@/lib/branch-filter";
import {
  hierarchyReadiness,
  useConfirmGroupMapping,
  useGroupStores,
  useItemGroups,
  useProposeGroupMapping,
  useSeedItemGroups,
  useSetGroupStore,
  useStockCategories,
  useStoreLocations,
} from "@/lib/stock-hierarchy";

const NONE = "__none__";

export function CatalogueHierarchy() {
  const { can } = useAuth();
  const canEdit = can("stores", "items", "edit") || can("administration", "workspace", "edit");
  const branchId = useWriteBranchId();

  const groups = useItemGroups();
  const categories = useStockCategories();
  const groupStores = useGroupStores();
  const locations = useStoreLocations(branchId);

  const seed = useSeedItemGroups();
  const propose = useProposeGroupMapping();
  const confirm = useConfirmGroupMapping();
  const setStore = useSetGroupStore();

  const groupList = groups.data ?? [];
  const categoryList = categories.data ?? [];
  const storeList = groupStores.data ?? [];
  const readiness = hierarchyReadiness(groupList, categoryList, storeList);

  const storeFor = (groupId: string) =>
    storeList.find((s) => s.groupId === groupId && s.branchId === branchId)?.locationId ??
    storeList.find((s) => s.groupId === groupId && s.branchId === null)?.locationId ??
    null;

  const run = async (fn: () => Promise<number>, done: (n: number) => string) => {
    try {
      const n = await fn();
      toast.success(done(n));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That did not go through.");
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Where the catalogue stands"
        description="Item group → category → stock item. A group is a classification. Its store is only the fallback used when a stock item has no default store of its own."
        actions={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={seed.isPending}
                onClick={() =>
                  run(
                    () => seed.mutateAsync(),
                    (n) => (n ? `${n} item group(s) created.` : "The standard groups already exist."),
                  )
                }
              >
                Create the standard groups
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={propose.isPending || groupList.length === 0}
                onClick={() =>
                  run(
                    () => propose.mutateAsync(),
                    (n) =>
                      n
                        ? `${n} suggestion(s) drafted — review each one below.`
                        : "Nothing new to suggest.",
                  )
                }
              >
                Suggest a grouping
              </Button>
            </div>
          ) : null
        }
      >
        <dl className="grid gap-4 sm:grid-cols-4">
          <Fact label="Item groups" value={String(readiness.groups)} />
          <Fact label="Categories placed" value={`${readiness.mapped} of ${readiness.categories}`} />
          <Fact label="Awaiting your decision" value={String(readiness.proposed)} />
          <Fact
            label="Groups with a fallback store"
            value={`${readiness.groupsWithStore} of ${readiness.groups}`}
          />
        </dl>
        {!readiness.ready ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Until this is complete, some items have neither a default store nor a group fallback,
            so whoever raises a request will have to choose a store by hand.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Fallback store for each group"
        description="Used only when a stock item has no default store of its own. An item is never restricted to its group's store — milk can sit in the chiller while its group falls back to the main food store. Routing order: the store chosen on the transaction, then the item's default store, then this fallback."
      >
        <QueryState
          isLoading={groups.isLoading || locations.isLoading}
          error={groups.error ?? locations.error}
          isEmpty={groupList.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No item groups yet. Create the standard groups above, or add your own on the Item
              groups tab.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {groupList.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{g.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {categoryList.filter((c) => c.groupId === g.id).length} categor
                    {categoryList.filter((c) => c.groupId === g.id).length === 1 ? "y" : "ies"}
                  </p>
                </div>
                <Select
                  value={storeFor(g.id) ?? NONE}
                  disabled={!canEdit || setStore.isPending}
                  onValueChange={(v) =>
                    setStore
                      .mutateAsync({
                        groupId: g.id,
                        branchId,
                        locationId: v === NONE ? null : v,
                      })
                      .then(() => toast.success("Store updated."))
                      .catch((e: unknown) =>
                        toast.error(e instanceof Error ? e.message : "That did not go through."),
                      )
                  }
                >
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder="No store chosen" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No store chosen</SelectItem>
                    {(locations.data ?? []).map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Categories and their group"
        description="Suggestions are drafts. A category only moves when you confirm it here."
      >
        <QueryState
          isLoading={categories.isLoading}
          error={categories.error}
          isEmpty={categoryList.length === 0}
          empty={<p className="py-6 text-sm text-muted-foreground">No categories yet.</p>}
        >
          <ul className="divide-y divide-border">
            {categoryList.map((c) => {
              const suggested = groupList.find((g) => g.id === c.proposedGroupId);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{c.name}</p>
                    {c.groupId ? null : suggested ? (
                      <p className="text-xs text-muted-foreground">
                        Suggested: {suggested.name} — {c.proposedReason}
                      </p>
                    ) : (
                      <Badge variant="outline" className="mt-1">
                        Not grouped
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={c.groupId ?? NONE}
                      disabled={!canEdit || confirm.isPending}
                      onValueChange={(v) =>
                        confirm
                          .mutateAsync({ categoryId: c.id, groupId: v === NONE ? null : v })
                          .then(() => toast.success("Category updated."))
                          .catch((e: unknown) =>
                            toast.error(
                              e instanceof Error ? e.message : "That did not go through.",
                            ),
                          )
                      }
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue placeholder="Choose a group" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>No group</SelectItem>
                        {groupList.map((g) => (
                          <SelectItem key={g.id} value={g.id}>
                            {g.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {canEdit && !c.groupId && c.proposedGroupId ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          confirm
                            .mutateAsync({ categoryId: c.id, groupId: c.proposedGroupId })
                            .then(() => toast.success("Suggestion accepted."))
                            .catch((e: unknown) =>
                              toast.error(
                                e instanceof Error ? e.message : "That did not go through.",
                              ),
                            )
                        }
                      >
                        Accept
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}

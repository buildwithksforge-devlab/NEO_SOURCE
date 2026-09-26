/**
 * Item groups, with the categories that sit inside each one.
 *
 * The catalogue has three levels — item group → category → stock item — and
 * this panel owns the top two. A category is always created inside the group
 * it was opened from, so the two can never be confused for one another.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

type Group = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  sort_order: number;
};

type Category = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  group_id: string | null;
};

type GroupDraft = { id?: string; name: string; description: string; active: boolean };
type CategoryDraft = { id?: string; groupId: string; name: string; description: string; active: boolean };

export function ItemGroupsPanel({ canEdit }: { canEdit: boolean }) {
  const { organizationId, user, profile } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft | null>(null);

  const groups = useQuery({
    queryKey: ["item-groups", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<Group[]> => {
      const { data, error } = await db
        .from("stock_item_groups")
        .select("id, name, description, active, sort_order")
        .order("sort_order")
        .order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as Group[];
    },
  });

  const categories = useQuery({
    queryKey: ["item-group-categories", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<Category[]> => {
      const { data, error } = await db
        .from("stock_categories")
        .select("id, name, description, active, group_id")
        .order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as Category[];
    },
  });

  const itemCounts = useQuery({
    queryKey: ["item-group-item-counts", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await db.from("stock_items").select("category_id");
      if (error) throw new Error(error.message);
      const counts: Record<string, number> = {};
      for (const row of (data ?? []) as { category_id: string | null }[]) {
        if (!row.category_id) continue;
        counts[row.category_id] = (counts[row.category_id] ?? 0) + 1;
      }
      return counts;
    },
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["item-groups"] });
    void qc.invalidateQueries({ queryKey: ["item-group-categories"] });
    void qc.invalidateQueries({ queryKey: ["config-collection"] });
    void qc.invalidateQueries({ queryKey: ["config-collection-lookups"] });
    void qc.invalidateQueries({ queryKey: ["stock-hierarchy"] });
  };

  const saveGroup = useMutation({
    mutationFn: async (draft: GroupDraft) => {
      const patch = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        active: draft.active,
      };
      if (draft.id) {
        const { error } = await db.from("stock_item_groups").update(patch).eq("id", draft.id);
        if (error) throw new Error(error.message);
        await logAudit({
          organizationId,
          userId: user?.id ?? null,
          userName: profile?.full_name,
          action: "inventory.stock_item_groups.updated",
          module: "inventory",
          recordId: draft.id,
          newValue: patch,
        });
        return;
      }
      const { data, error } = await db
        .from("stock_item_groups")
        .insert({ ...patch, organization_id: organizationId })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name,
        action: "inventory.stock_item_groups.created",
        module: "inventory",
        recordId: (data as { id: string }).id,
        newValue: patch,
      });
    },
    onSuccess: () => {
      toast.success("Item group saved");
      setGroupDraft(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveCategory = useMutation({
    mutationFn: async (draft: CategoryDraft) => {
      const patch = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        active: draft.active,
        group_id: draft.groupId,
        group_confirmed_at: new Date().toISOString(),
      };
      if (draft.id) {
        const { error } = await db.from("stock_categories").update(patch).eq("id", draft.id);
        if (error) throw new Error(error.message);
        await logAudit({
          organizationId,
          userId: user?.id ?? null,
          userName: profile?.full_name,
          action: "inventory.stock_categories.updated",
          module: "inventory",
          recordId: draft.id,
          newValue: patch,
        });
        return;
      }
      const { data, error } = await db
        .from("stock_categories")
        .insert({ ...patch, organization_id: organizationId })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name,
        action: "inventory.stock_categories.created",
        module: "inventory",
        recordId: (data as { id: string }).id,
        newValue: patch,
      });
    },
    onSuccess: () => {
      toast.success("Category saved");
      setCategoryDraft(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const byGroup = useMemo(() => {
    const map: Record<string, Category[]> = {};
    for (const c of categories.data ?? []) {
      const key = c.group_id ?? "__none__";
      (map[key] ??= []).push(c);
    }
    return map;
  }, [categories.data]);

  const groupList = groups.data ?? [];
  const ungrouped = byGroup["__none__"] ?? [];
  const loading = groups.isLoading || categories.isLoading;

  return (
    <SectionCard
      title="Item Groups"
      description="Create item groups to organise your inventory and structure stock categories."
      actions={
        canEdit ? (
          <Button
            size="sm"
            onClick={() => setGroupDraft({ name: "", description: "", active: true })}
          >
            <Plus className="mr-1.5 size-4" />
            Add Item Group
          </Button>
        ) : undefined
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading item groups…
        </div>
      ) : groupList.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
          <p className="text-sm font-medium text-foreground">No item groups yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add your first item group to start organising your inventory.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {groupList.map((group) => {
            const children = byGroup[group.id] ?? [];
            const expanded = open[group.id] ?? true;
            return (
              <li key={group.id} className="rounded-xl border border-border">
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 text-left"
                    onClick={() => setOpen((o) => ({ ...o, [group.id]: !expanded }))}
                    aria-expanded={expanded}
                  >
                    {expanded ? (
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {group.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {children.length} categor{children.length === 1 ? "y" : "ies"}
                        {group.description ? ` · ${group.description}` : ""}
                      </span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill tone={group.active ? "success" : "default"}>
                      {group.active ? "Active" : "Inactive"}
                    </StatusPill>
                    {canEdit ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setGroupDraft({
                              id: group.id,
                              name: group.name,
                              description: group.description ?? "",
                              active: group.active,
                            })
                          }
                        >
                          <Pencil className="mr-1.5 size-3.5" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setCategoryDraft({
                              groupId: group.id,
                              name: "",
                              description: "",
                              active: true,
                            })
                          }
                        >
                          <Plus className="mr-1.5 size-3.5" />
                          Add Category
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                {expanded ? (
                  children.length === 0 ? (
                    <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                      No categories in this group yet.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border border-t border-border">
                      {children.map((category) => (
                        <li
                          key={category.id}
                          className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm text-foreground">{category.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {itemCounts.data?.[category.id] ?? 0} stock item
                              {(itemCounts.data?.[category.id] ?? 0) === 1 ? "" : "s"}
                              {category.description ? ` · ${category.description}` : ""}
                            </p>
                          </div>
                          {canEdit ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setCategoryDraft({
                                  id: category.id,
                                  groupId: group.id,
                                  name: category.name,
                                  description: category.description ?? "",
                                  active: category.active,
                                })
                              }
                            >
                              <Pencil className="mr-1.5 size-3.5" />
                              Edit
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {ungrouped.length > 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border p-3">
          <p className="text-sm font-medium text-foreground">Categories without an item group</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {ungrouped.map((c) => c.name).join(", ")} — open each one and choose its group so
            requisitions can route to the right store.
          </p>
          {canEdit ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {ungrouped.map((c) => (
                <Button
                  key={c.id}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setCategoryDraft({
                      id: c.id,
                      groupId: groupList[0]?.id ?? "",
                      name: c.name,
                      description: c.description ?? "",
                      active: c.active,
                    })
                  }
                >
                  {c.name}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog open={groupDraft !== null} onOpenChange={(o) => (o ? null : setGroupDraft(null))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{groupDraft?.id ? "Edit item group" : "Add Item Group"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="group-name">
                Item Group Name<span className="ml-1 text-destructive">*</span>
              </Label>
              <Input
                id="group-name"
                value={groupDraft?.name ?? ""}
                placeholder="Beverages"
                onChange={(e) => setGroupDraft((d) => (d ? { ...d, name: e.target.value } : d))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-description">Description</Label>
              <Textarea
                id="group-description"
                value={groupDraft?.description ?? ""}
                onChange={(e) =>
                  setGroupDraft((d) => (d ? { ...d, description: e.target.value } : d))
                }
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="group-active"
                checked={groupDraft?.active ?? true}
                onCheckedChange={(v) => setGroupDraft((d) => (d ? { ...d, active: v } : d))}
              />
              <Label htmlFor="group-active">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGroupDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={!groupDraft?.name.trim() || saveGroup.isPending}
              onClick={() => groupDraft && saveGroup.mutate(groupDraft)}
            >
              {saveGroup.isPending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={categoryDraft !== null}
        onOpenChange={(o) => (o ? null : setCategoryDraft(null))}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{categoryDraft?.id ? "Edit category" : "Add Category"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="category-group">
                Item Group<span className="ml-1 text-destructive">*</span>
              </Label>
              {/* A category can be moved to another group here — a category
                  filed in the wrong group has to be correctable. */}
              <Select
                value={categoryDraft?.groupId ?? ""}
                onValueChange={(v) => setCategoryDraft((d) => (d ? { ...d, groupId: v } : d))}
              >
                <SelectTrigger id="category-group">
                  <SelectValue placeholder="Choose an item group" />
                </SelectTrigger>
                <SelectContent>
                  {groupList.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="category-name">
                Category Name<span className="ml-1 text-destructive">*</span>
              </Label>
              <Input
                id="category-name"
                value={categoryDraft?.name ?? ""}
                onChange={(e) =>
                  setCategoryDraft((d) => (d ? { ...d, name: e.target.value } : d))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category-description">Description</Label>
              <Textarea
                id="category-description"
                value={categoryDraft?.description ?? ""}
                onChange={(e) =>
                  setCategoryDraft((d) => (d ? { ...d, description: e.target.value } : d))
                }
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="category-active"
                checked={categoryDraft?.active ?? true}
                onCheckedChange={(v) => setCategoryDraft((d) => (d ? { ...d, active: v } : d))}
              />
              <Label htmlFor="category-active">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCategoryDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                !categoryDraft?.name.trim() || !categoryDraft?.groupId || saveCategory.isPending
              }
              onClick={() => categoryDraft && saveCategory.mutate(categoryDraft)}
            >
              {saveCategory.isPending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

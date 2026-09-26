import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "@/components/common/FormDialog";
import { useDirtyForm } from "@/lib/use-dirty-form";
import { AlertTriangle } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
import { EmptyState } from "@/components/pos/PosShared";
import { MenuImageField } from "@/components/pos/MenuImageField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { MENU_AVAILABILITY, money, titleCase } from "@/lib/pos";
import { useAttachRecipeToMenuItem, useMenuRecipeOptions } from "@/lib/recipe-master";
import {
  canHardDeleteMenu,
  MENU_SERVICE_TYPES,
  MENU_STATUSES,
  MENU_OUTLETS,
  MENU_OUTLET_LABELS,
  menusForBranch,
  pruneMenuSelection,
} from "@/lib/menu-scoping";
import {
  useBranches,
  useDeleteMenu,
  useMenuCategories,
  useMenuDepartments,
  useMenuItemDetail,
  useMenuStations,
  useMenus,
  useSaveMenu,
  useSaveMenuItem,
  useSetMenuStatus,
} from "@/lib/pos-data";

type MenuRow = {
  id: string;
  name: string;
  description?: string | null;
  branch_id: string | null;
  service_type?: string | null;
  status?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  valid_time_from?: string | null;
  valid_time_to?: string | null;
};

const STATUS_TONE: Record<string, "success" | "warning" | "default"> = {
  active: "success",
  inactive: "warning",
  retired: "default",
};

/**
 * Chained property → department → station picker. Every dependent selection is
 * cleared the moment the selection above it makes it invalid, and the options
 * come from the same database functions that refuse an invalid write.
 */
function ChainPicker({
  branchId,
  departmentId,
  stationId,
  lockBranch,
  onChange,
}: {
  branchId: string | null;
  departmentId: string | null;
  stationId: string | null;
  lockBranch?: boolean;
  onChange: (next: { branchId: string | null; departmentId: string | null; stationId: string | null }) => void;
}) {
  const branches = useBranches();
  const departments = useMenuDepartments(branchId);
  const stations = useMenuStations(branchId, departmentId);

  // A change of property or department can strand a stale choice below it.
  // Only judge a selection once the options it would be judged against have
  // actually arrived — an unresolved query is not evidence of invalidity.
  const departmentsReady = departments.isSuccess;
  const stationsReady = stations.isSuccess;
  useEffect(() => {
    if (!departmentsReady) return;
    const pruned = pruneMenuSelection(
      departments.data ?? [],
      stations.data ?? [],
      branchId,
      departmentId,
      stationId,
    );
    const nextStation = stationsReady ? pruned.stationId : stationId;
    if (pruned.departmentId !== departmentId || nextStation !== stationId) {
      onChange({ branchId, departmentId: pruned.departmentId, stationId: pruned.departmentId ? nextStation : null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, departmentId, stationId, departments.data, stations.data, departmentsReady, stationsReady]);


  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="space-y-1.5">
        <Label>Property</Label>
        <Select
          value={branchId ?? ""}
          disabled={Boolean(lockBranch)}
          onValueChange={(v) => onChange({ branchId: v, departmentId: null, stationId: null })}
        >
          <SelectTrigger aria-label="Select property">
            <SelectValue placeholder="Select a property" />
          </SelectTrigger>
          <SelectContent>
            {(branches.data ?? []).map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>Department</Label>
        <Select
          value={departmentId ?? ""}
          disabled={!branchId}
          onValueChange={(v) => onChange({ branchId, departmentId: v, stationId: null })}
        >
          <SelectTrigger aria-label="Select department">
            <SelectValue placeholder={branchId ? "Select a department" : "Select a property first"} />
          </SelectTrigger>
          <SelectContent>
            {(departments.data ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>Production station</Label>
        <Select
          value={stationId ?? ""}
          disabled={!branchId || !departmentId}
          onValueChange={(v) => onChange({ branchId, departmentId, stationId: v })}
        >
          <SelectTrigger aria-label="Select production station">
            <SelectValue placeholder={departmentId ? "Select a station" : "Select a department first"} />
          </SelectTrigger>
          <SelectContent>
            {(stations.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {branchId && departmentId && (stations.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No station is configured for this department at this property.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Create or edit a menu: name, description, service type, schedule and status. */
export function MenuFormDialog({
  open,
  onOpenChange,
  menu,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  menu?: MenuRow | null;
}) {
  const { branchId: activeBranch } = useActivePropertyFilter();
  const branches = useBranches();
  const save = useSaveMenu();
  const editing = Boolean(menu?.id);

  const [branchId, setBranchId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    serviceType: "all-day",
    outlet: "all",
    status: "active",
    validFrom: "",
    validTo: "",
    validTimeFrom: "",
    validTimeTo: "",
  });

  useEffect(() => {
    if (!open) return;
    setBranchId(menu?.branch_id ?? activeBranch ?? null);
    setForm({
      name: menu?.name ?? "",
      description: menu?.description ?? "",
      serviceType: menu?.service_type ?? "all-day",
      outlet: (menu as { outlet?: string | null } | null | undefined)?.outlet ?? "all",
      status: menu?.status ?? "active",
      validFrom: menu?.valid_from ?? "",
      validTo: menu?.valid_to ?? "",
      validTimeFrom: menu?.valid_time_from?.slice(0, 5) ?? "",
      validTimeTo: menu?.valid_time_to?.slice(0, 5) ?? "",
    });
  }, [open, menu, activeBranch]);

  const submit = async () => {
    if (!branchId) return;
    await save.mutateAsync({
      id: menu?.id ?? null,
      name: form.name,
      description: form.description || null,
      branchId,
      serviceType: form.serviceType,
      outlet: form.outlet,
      status: form.status,
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
      validTimeFrom: form.validTimeFrom || null,
      validTimeTo: form.validTimeTo || null,
    });
    markSaved(snapshot);
    onOpenChange(false);
  };

  const snapshot = useMemo(() => ({ ...form, branchId }), [form, branchId]);
  const { dirty, setBaseline, markSaved } = useDirtyForm(snapshot, { enabled: editing });
  useEffect(() => {
    if (open) setBaseline(snapshot);
    // Baseline is the state the menu was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menu?.id]);

  const valid = Boolean(branchId && form.name.trim());

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={editing ? "Edit menu" : "New menu"}
      description="A menu belongs to one property. Its property cannot change once created, because its categories and items would follow it."
      submitLabel="Save menu"
      busyLabel="Saving…"
      busy={save.isPending}
      canSubmit={valid && dirty}
      onSubmit={() => void submit()}
      footerNote={editing && valid && !dirty ? "No changes to save yet." : undefined}
    >
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label>Property</Label>
            <Select value={branchId ?? ""} disabled={editing} onValueChange={setBranchId}>
              <SelectTrigger aria-label="Menu property">
                <SelectValue placeholder="Select a property" />
              </SelectTrigger>
              <SelectContent>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Menu name</Label>
            <Input
              value={form.name}
              aria-label="Menu name"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              value={form.description}
              aria-label="Menu description"
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Service type</Label>
              <Select value={form.serviceType} onValueChange={(v) => setForm((f) => ({ ...f, serviceType: v }))}>
                <SelectTrigger aria-label="Service type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MENU_SERVICE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Outlet</Label>
              <Select value={form.outlet} onValueChange={(v) => setForm((f) => ({ ...f, outlet: v }))}>
                <SelectTrigger aria-label="Menu outlet">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MENU_OUTLETS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {MENU_OUTLET_LABELS[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A bar terminal sells only bar menus. Leave on all outlets to sell it everywhere.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger aria-label="Menu status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MENU_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div className="col-span-2 space-y-1.5">
              <Label>Valid period</Label>
              <NeoDateRangePicker
                from={form.validFrom}
                to={form.validTo}
                onChange={({ from, to }) => setForm((f) => ({ ...f, validFrom: from, validTo: to }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Serving from</Label>
              <Input
                type="time"
                aria-label="Serving from"
                value={form.validTimeFrom}
                onChange={(e) => setForm((f) => ({ ...f, validTimeFrom: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Serving to</Label>
              <Input
                type="time"
                aria-label="Serving to"
                value={form.validTimeTo}
                onChange={(e) => setForm((f) => ({ ...f, validTimeTo: e.target.value }))}
              />
            </div>
          </div>
        </div>
    </FormDialog>
  );
}

/** Create or edit a menu item under the enforced property → department → station chain. */
export function MenuItemFormDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item?: {
    id: string;
    name: string;
    branch_id: string | null;
    category_id: string | null;
    department_id: string | null;
    station_id: string | null;
    base_price: number;
    tax_rate: number | null;
    availability: string;
    sku?: string | null;
    image_url?: string | null;
    currency?: string | null;
  } | null | undefined;
}) {
  const { branchId: activeBranch } = useActivePropertyFilter();
  const menus = useMenus();
  const categories = useMenuCategories();
  const save = useSaveMenuItem();
  const recipes = useMenuRecipeOptions();
  const attachRecipe = useAttachRecipeToMenuItem();
  const editing = Boolean(item?.id);
  // The catalogue reader does not carry description or prep minutes; read them
  // so an edit never silently blanks a field the form did not show.
  const detail = useMenuItemDetail(open && item?.id ? item.id : null);
  const detailReady = !editing || detail.isSuccess;

  const [chain, setChain] = useState<{ branchId: string | null; departmentId: string | null; stationId: string | null }>(
    { branchId: null, departmentId: null, stationId: null },
  );
  const [menuId, setMenuId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    basePrice: "0",
    taxRate: "0",
    prepMinutes: "10",
    availability: "available",
    sku: "",
  });
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [recipeId, setRecipeId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChain({
      branchId: item?.branch_id ?? activeBranch ?? null,
      departmentId: item?.department_id ?? null,
      stationId: item?.station_id ?? null,
    });
    setCategoryId(item?.category_id ?? null);
    setMenuId(null);
    setImagePath(item?.image_url ?? null);
    setRecipeId(null);
    setForm({
      name: item?.name ?? "",
      description: "",
      basePrice: String(item?.base_price ?? 0),
      taxRate: String(item?.tax_rate ?? 0),
      prepMinutes: "10",
      availability: item?.availability ?? "available",
      sku: item?.sku ?? "",
    });
  }, [open, item, activeBranch]);

  // Fill in the stored description, prep time, SKU and photo once they arrive,
  // so an edit never silently blanks a field the form did not show.
  useEffect(() => {
    if (!open || !editing || !detail.data || detail.data.id !== item?.id) return;
    setForm((f) => ({
      ...f,
      description: detail.data?.description ?? "",
      prepMinutes: String(detail.data?.prep_minutes ?? 10),
      sku: detail.data?.sku ?? f.sku,
    }));
    setImagePath(detail.data.image_url ?? null);
  }, [open, editing, detail.data, item?.id]);


  // Recipe currently attached to this menu item, so the dropdown opens on it.
  useEffect(() => {
    if (!open || !item?.id) return;
    const current = recipes.options.find((o) => o.menuItemId === item.id);
    if (current) setRecipeId(current.value);
  }, [open, item?.id, recipes.options]);

  const branchMenus = useMemo(
    () => menusForBranch((menus.data ?? []) as unknown as MenuRow[], chain.branchId),
    [menus.data, chain.branchId],
  );

  const branchCategories = useMemo(() => {
    const allowed = new Set(branchMenus.map((m) => m.id));
    return ((categories.data ?? []) as Record<string, unknown>[]).filter(
      (c) => allowed.has(String(c["menu_id"])) && (!menuId || String(c["menu_id"]) === menuId),
    );
  }, [categories.data, branchMenus, menuId]);

  // A category from a menu of another property can never survive a property
  // change — but a still-loading category list is not a wrong property, so the
  // selection is only cleared once the options are actually known.
  const optionsLoaded = categories.isSuccess && menus.isSuccess;
  useEffect(() => {
    if (!optionsLoaded) return;
    if (categoryId && !branchCategories.some((c) => String(c["id"]) === categoryId)) setCategoryId(null);
  }, [optionsLoaded, branchCategories, categoryId]);

  // Frontend dirty state: the values the form holds, compared with the values
  // it was opened with. Nothing about the mutation itself changes.
  const snapshot = useMemo(
    () => ({ ...form, ...chain, categoryId, imagePath, recipeId }),
    [form, chain, categoryId, imagePath, recipeId],
  );
  const { dirty, setBaseline, markSaved } = useDirtyForm(snapshot, { enabled: editing });

  // Baseline is taken once the stored detail has arrived, so the values the
  // user actually sees are the ones "unchanged" means.
  useEffect(() => {
    if (!open) return;
    if (editing && !detail.isSuccess) return;
    setBaseline(snapshot);
    // Only re-baseline when the form is (re)opened or the record finished loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, detail.isSuccess, item?.id]);

  const submit = async () => {
    const result = await save.mutateAsync({
      id: item?.id ?? null,
      name: form.name,
      description: form.description || null,
      branchId: chain.branchId,
      categoryId,
      departmentId: chain.departmentId,
      stationId: chain.stationId,
      basePrice: Number(form.basePrice) || 0,
      taxRate: Number(form.taxRate) || 0,
      prepMinutes: Number(form.prepMinutes) || 10,
      availability: form.availability,
      imageUrl: imagePath,
      sku: form.sku.trim() || null,
    });
    const savedId = item?.id ?? result?.item_id ?? null;
    if (recipeId && savedId) {
      await attachRecipe.mutateAsync({ recipeId, menuItemId: savedId });
    }
    // On success the saved values become the new baseline; on error the
    // mutation throws and the edits (and the dirty state) are preserved.
    markSaved(snapshot);
    onOpenChange(false);
  };

  const valid = Boolean(
    detailReady && chain.branchId && chain.departmentId && chain.stationId && categoryId && form.name.trim(),
  );
  const ready = valid && dirty;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={editing ? "Edit menu item" : "New menu item"}
      description="Choose the property first. Only the departments of that property, and only the stations of that department, can be selected — a station from another property is refused."
      submitLabel="Save item"
      busyLabel="Saving…"
      busy={save.isPending}
      canSubmit={ready}
      onSubmit={() => void submit()}
      footerNote={
        editing && valid && !dirty ? "No changes to save yet." : undefined
      }
    >
        <div className="grid gap-4">
          <ChainPicker {...chain} onChange={setChain} />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Menu</Label>
              <Select
                value={menuId ?? ""}
                disabled={!chain.branchId}
                onValueChange={(v) => {
                  setMenuId(v);
                  setCategoryId(null);
                }}
              >
                <SelectTrigger aria-label="Select menu">
                  <SelectValue placeholder={chain.branchId ? "Select a menu" : "Select a property first"} />
                </SelectTrigger>
                <SelectContent>
                  {branchMenus.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={categoryId ?? ""} disabled={!chain.branchId} onValueChange={setCategoryId}>
                <SelectTrigger aria-label="Select category">
                  <SelectValue placeholder={menuId ? "Select a category" : "Select a menu first"} />
                </SelectTrigger>
                <SelectContent>
                  {branchCategories.map((c) => (
                    <SelectItem key={String(c["id"])} value={String(c["id"])}>
                      {String(c["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Item name</Label>
              <Input
                aria-label="Item name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Availability</Label>
              <Select value={form.availability} onValueChange={(v) => setForm((f) => ({ ...f, availability: v }))}>
                <SelectTrigger aria-label="Item availability">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MENU_AVAILABILITY.map((a) => (
                    <SelectItem key={a} value={a}>
                      {titleCase(a)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              aria-label="Item description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Price</Label>
              <Input
                type="number"
                aria-label="Item price"
                value={form.basePrice}
                onChange={(e) => setForm((f) => ({ ...f, basePrice: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Tax rate %</Label>
              <Input
                type="number"
                aria-label="Item tax rate"
                value={form.taxRate}
                onChange={(e) => setForm((f) => ({ ...f, taxRate: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Prep minutes</Label>
              <Input
                type="number"
                aria-label="Item prep minutes"
                value={form.prepMinutes}
                onChange={(e) => setForm((f) => ({ ...f, prepMinutes: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <MenuImageField value={imagePath} itemName={form.name} onChange={setImagePath} />
            <div className="space-y-1.5">
              <Label>SKU / item code</Label>
              <Input
                aria-label="Item SKU"
                value={form.sku}
                placeholder="e.g. FB-BRK-014"
                onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Imports match on this code, so a re-upload updates the item instead of duplicating it.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Recipe</Label>
            <Select value={recipeId ?? "none"} onValueChange={(v) => setRecipeId(v === "none" ? null : v)}>
              <SelectTrigger aria-label="Recipe">
                <SelectValue placeholder="No recipe attached" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No recipe attached</SelectItem>
                {recipes.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Attaching an active recipe is what lets a sale of this item deduct its ingredients from stock.
            </p>
          </div>
        </div>
    </FormDialog>
  );
}

/**
 * The Menu Catalogue management surface: every menu of the selected property,
 * with its schedule, status and the safe lifecycle actions. Removal is offered
 * only when nothing references the menu; otherwise deactivate or retire.
 */
export function MenuCatalogueSection({ itemCounts }: { itemCounts: Map<string, number> }) {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const menus = useMenus();
  const categories = useMenuCategories();
  const branches = useBranches();
  const setStatus = useSetMenuStatus();
  const remove = useDeleteMenu();

  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState<MenuRow | null>(null);

  const manage = can("restaurant", "menu.edit") || can("pos", "menu.edit");
  const canCreate = can("restaurant", "menu.create") || manage;
  const canRemove = can("restaurant", "menu.delete");

  const branchName = useMemo(
    () => new Map((branches.data ?? []).map((b) => [b.id, b.name])),
    [branches.data],
  );

  const rows = useMemo(
    () => menusForBranch((menus.data ?? []) as unknown as MenuRow[], branchId),
    [menus.data, branchId],
  );

  const categoryCount = (menuId: string) =>
    ((categories.data ?? []) as Record<string, unknown>[]).filter((c) => String(c["menu_id"]) === menuId).length;

  return (
    <SectionCard
      title="Menu catalogue"
      description={
        branchId
          ? "Menus of the selected property, with their service period, schedule and status."
          : "All properties are selected, so every property's menus are shown and labelled."
      }
      actions={
        canCreate ? (
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialog(true);
            }}
          >
            New menu
          </Button>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          title="No menus for this property"
          description="A menu groups the categories and items one property actually sells."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Menu</TableHead>
              {!branchId ? <TableHead>Property</TableHead> : null}
              <TableHead>Service</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Contents</TableHead>
              <TableHead>Status</TableHead>
              {manage ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => {
              const cats = categoryCount(m.id);
              const items = itemCounts.get(m.id) ?? 0;
              const safeToDelete = canHardDeleteMenu({ categories: cats, items });
              return (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">
                    {m.name}
                    {m.description ? (
                      <span className="block text-xs text-muted-foreground">{m.description}</span>
                    ) : null}
                  </TableCell>
                  {!branchId ? (
                    <TableCell className="text-sm">
                      {m.branch_id ? (branchName.get(m.branch_id) ?? "Unknown property") : "Organisation-wide"}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-sm">{titleCase(m.service_type ?? "all-day")}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {m.valid_from || m.valid_to ? `${m.valid_from ?? "—"} → ${m.valid_to ?? "—"}` : "No date limit"}
                    <span className="block">
                      {m.valid_time_from || m.valid_time_to
                        ? `${m.valid_time_from?.slice(0, 5) ?? "—"} – ${m.valid_time_to?.slice(0, 5) ?? "—"}`
                        : "All day"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {cats} categor{cats === 1 ? "y" : "ies"} · {items} item{items === 1 ? "" : "s"}
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={STATUS_TONE[m.status ?? "active"] ?? "default"}>
                      {titleCase(m.status ?? "active")}
                    </StatusPill>
                  </TableCell>
                  {manage ? (
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(m);
                            setDialog(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Select
                          value={m.status ?? "active"}
                          onValueChange={(v) => setStatus.mutate({ id: m.id, status: v })}
                        >
                          <SelectTrigger className="w-36" aria-label={`Status for ${m.name}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MENU_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {titleCase(s)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {canRemove ? (
                          safeToDelete ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              onClick={() => remove.mutate(m.id)}
                            >
                              Remove
                            </Button>
                          ) : (
                            <span
                              className="flex items-center gap-1 text-xs text-muted-foreground"
                              title="This menu is referenced by categories or items. Deactivate or retire it instead."
                            >
                              <AlertTriangle className="size-3.5" /> In use
                            </span>
                          )
                        ) : null}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <MenuFormDialog open={dialog} onOpenChange={setDialog} menu={editing} />
    </SectionCard>
  );
}

export { money };

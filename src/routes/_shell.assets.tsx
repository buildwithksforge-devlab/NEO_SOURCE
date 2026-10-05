/**
 * Assets & Equipment register.
 *
 * Every fixed asset — furniture, kitchen equipment, IT gear, managed sets such
 * as 120 dinner plates — lives here with its custodian, location, condition
 * and movement trail. This register is operational only: depreciation and
 * asset accounting are a future Finance module extension, so nothing here
 * ever posts a Finance journal or computes a book/write-off value.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Boxes } from "lucide-react";
import { ImportWizard } from "@/components/onboarding/ImportWizard";
import { domainByKey } from "@/lib/onboarding/domains";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  CatalogueGroup,
  CatalogueQueryBar,
  CatalogueRail,
  CatalogueRow,
  CatalogueWorkspace,
  type ActiveFilterChip,
} from "@/components/common/CatalogueWorkspace";
import { InspectorField, InspectorSection, InspectorSheet } from "@/components/common/InspectorSheet";
import { FormDialog } from "@/components/common/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";
import { money, titleCase } from "@/lib/pos";
import {
  ASSET_CONDITIONS,
  ASSET_STATUSES,
  isAssetStatusTransitionAllowed,
  shortDate,
  type Row,
} from "@/lib/operations";
import { useDirtyForm } from "@/lib/use-dirty-form";
import { useRooms } from "@/lib/pms-data";
import { useSuppliers } from "@/lib/inventory-data";
import { useScopedDepartments, useScopedWorkers } from "@/lib/scoped-options";
import {
  proposeAssetTag,
  useAssetCategories,
  useAssetMovements,
  useAssetServiceHistory,
  useAssetTagPrefixes,
  useAssetWorkOrders,
  useAssets,
  useAssetCustodianNames,
  useMoveAsset,
  useSaveAsset,
  useSetAssetStatus,
} from "@/lib/operations-data";

export const Route = createFileRoute("/_shell/assets")({
  head: () => ({
    meta: [
      { title: "Assets & Equipment — NEØ" },
      {
        name: "description",
        content:
          "Register, locate and track fixed assets and managed equipment sets — custodian, condition, status and movement history for every property.",
      },
      { property: "og:title", content: "Assets & Equipment — NEØ" },
      {
        property: "og:description",
        content:
          "Register, locate and track fixed assets and managed equipment sets — custodian, condition, status and movement history for every property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="maintenance" action="assets.view">
      <AssetsPage />
    </OpsGuard>
  ),
});

function statusTone(status: string): "default" | "success" | "warning" | "destructive" | "info" {
  switch (status) {
    case "active":
    case "assigned":
      return "success";
    case "in-storage":
      return "default";
    case "under-maintenance":
      return "warning";
    case "out-of-service":
    case "lost":
      return "destructive";
    case "disposed":
    case "sold":
    case "retired":
      return "info";
    default:
      return "default";
  }
}

function conditionTone(condition: string): "default" | "success" | "warning" | "destructive" {
  switch (condition) {
    case "excellent":
    case "good":
      return "success";
    case "fair":
      return "warning";
    case "poor":
    case "unserviceable":
      return "destructive";
    default:
      return "default";
  }
}

type EditingAsset = {
  id?: string;
  asset_tag: string;
  name: string;
  description: string;
  category_id: string;
  serial_number: string;
  model: string;
  manufacturer: string;
  quantity: string;
  purchase_date: string;
  purchase_cost: string;
  supplier_id: string;
  purchase_reference: string;
  warranty_start: string;
  warranty_expiry: string;
  location_label: string;
  room_id: string;
  department_id: string;
  custodian_id: string;
  condition: string;
  status: string;
  criticality: string;
};

const BLANK_ASSET: EditingAsset = {
  asset_tag: "",
  name: "",
  description: "",
  category_id: "",
  serial_number: "",
  model: "",
  manufacturer: "",
  quantity: "1",
  purchase_date: "",
  purchase_cost: "",
  supplier_id: "",
  purchase_reference: "",
  warranty_start: "",
  warranty_expiry: "",
  location_label: "",
  room_id: "",
  department_id: "",
  custodian_id: "",
  condition: "good",
  status: "active",
  criticality: "normal",
};

function AssetsPage() {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const writeBranchId = useWriteBranchId();
  const { branding } = useBranding();

  const assets = useAssets();
  const assetCustodianNames = useAssetCustodianNames();
  const categories = useAssetCategories();
  const rooms = useRooms();
  const suppliers = useSuppliers();
  const departments = useScopedDepartments();
  const saveAsset = useSaveAsset();
  const moveAsset = useMoveAsset();
  const setStatus = useSetAssetStatus();

  // Registering, editing and retiring an asset is `assets.manage`; moving one
  // between departments or custodians is `assets.transfer`. Viewing alone never
  // unlocks either — the previous gate handed edit controls to every viewer.
  const manage = can("maintenance", "assets", "manage") || can("maintenance", "assets.manage");
  const canTransfer =
    manage || can("maintenance", "assets", "transfer") || can("maintenance", "assets.transfer");

  const [search, setSearch] = useState("");
  const [categoryRail, setCategoryRail] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [conditionFilter, setConditionFilter] = useState("all");
  const [inspectId, setInspectId] = useState<string | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [assetDialog, setAssetDialog] = useState(false);
  const [editing, setEditing] = useState<EditingAsset>(BLANK_ASSET);
  const [generatingTag, setGeneratingTag] = useState(false);

  const [transferDialog, setTransferDialog] = useState(false);
  const [transferLocation, setTransferLocation] = useState("");
  const [transferDepartment, setTransferDepartment] = useState("");
  const [transferCustodian, setTransferCustodian] = useState("");
  const [transferReason, setTransferReason] = useState("");

  const editingWorkers = useScopedWorkers({
    departmentId: editing.department_id || null,
    enabled: Boolean(editing.department_id),
  });

  const transferWorkers = useScopedWorkers({
    departmentId: transferDepartment || null,
    enabled: Boolean(transferDepartment),
  });

  const [statusDialog, setStatusDialog] = useState(false);
  const [nextStatus, setNextStatus] = useState("active");
  const [statusReason, setStatusReason] = useState("");

  // Property-owned rows are narrowed to the active property client-side; the
  // underlying read already keeps this scoped by organisation.
  const allRows = (assets.data ?? []) as Row[];
  const rows = useMemo(
    () => (branchId ? allRows.filter((r) => !r["branch_id"] || r["branch_id"] === branchId) : allRows),
    [allRows, branchId],
  );

  const categoryList = (categories.data ?? []) as Row[];
  const departmentList = departments.data ?? [];
  const roomList = (rooms.data ?? []) as Row[];
  const supplierList = (suppliers.data ?? []) as Row[];
  const editingWorkerList = editingWorkers.data ?? [];
  const transferWorkerList = transferWorkers.data ?? [];
  const assetCustodianList = assetCustodianNames.data ?? [];

  const assetCustodianNameByAssetId = new Map(
    assetCustodianList.map((row) => [
      String(row["asset_id"]),
      String(row["full_name"] ?? "Unassigned"),
    ]),
  );

  const departmentName = (id: unknown) =>
    departmentList.find((d) => d.id === id)?.name ?? "Unassigned";
  const custodianName = (asset: Record<string, unknown>) => {
    if (!asset["custodian_id"]) return "Unassigned";

    return (
      assetCustodianNameByAssetId.get(String(asset["id"])) ??
      editingWorkerList.find((w) => w.id === asset["custodian_id"])?.full_name ??
      transferWorkerList.find((w) => w.id === asset["custodian_id"])?.full_name ??
      "Custodian assigned"
    );
  };
  const roomLabel = (id: unknown) =>
    roomList.find((r) => r["id"] === id)?.["room_number"] ?? null;

  const term = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (categoryRail === "all" ||
            ((r["asset_categories"] as Row | null)?.["name"] ?? "Uncategorised") === categoryRail) &&
          (departmentFilter === "all" || String(r["department_id"] ?? "") === departmentFilter) &&
          (statusFilter === "all" || r["status"] === statusFilter) &&
          (conditionFilter === "all" || r["condition"] === conditionFilter) &&
          (!term ||
            String(r["name"] ?? "").toLowerCase().includes(term) ||
            String(r["asset_tag"] ?? "").toLowerCase().includes(term) ||
            String(r["serial_number"] ?? "").toLowerCase().includes(term) ||
            String(r["location_label"] ?? "").toLowerCase().includes(term)),
      ),
    [rows, categoryRail, departmentFilter, statusFilter, conditionFilter, term],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const row of filtered) {
      const key = (row["asset_categories"] as Row | null)?.["name"] ?? "Uncategorised";
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const uncategorised = rows.filter((r) => !(r["asset_categories"] as Row | null)?.["name"]).length;
  const railItems = [
    ...categoryList.map((c) => ({
      id: c["name"] as string,
      label: c["name"] as string,
      count: rows.filter((r) => (r["asset_categories"] as Row | null)?.["name"] === c["name"]).length,
    })),
    // Uncategorised lines are the ones configuration has to act on, so they are
    // reachable in one click rather than hidden between the named categories.
    ...(uncategorised ? [{ id: "Uncategorised", label: "Uncategorised", count: uncategorised }] : []),
  ];

  const totalQuantity = rows.reduce((sum, r) => sum + (Number(r["quantity"]) || 1), 0);
  const activeCount = rows.filter((r) => r["status"] === "active" || r["status"] === "assigned").length;
  const maintenanceCount = rows.filter(
    (r) => r["status"] === "under-maintenance" || r["status"] === "out-of-service",
  ).length;
  const totalCost = rows.reduce((sum, r) => sum + (Number(r["purchase_cost"]) || 0), 0);

  const today = new Date();
  const horizon = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);
  const attentionCount = rows.filter((r) => {
    const warranty = r["warranty_expiry"] as string | null;
    const service = r["next_service_date"] as string | null;
    return (
      (warranty && warranty >= todayIso && warranty <= horizon) ||
      (service && service <= horizon)
    );
  }).length;

  const leadFigure: SummaryFigure = {
    id: "total",
    label: "Total units",
    value: assets.isLoading ? "…" : totalQuantity,
    hint: `${rows.length} register line${rows.length === 1 ? "" : "s"} · quantities included`,
  };
  const figures: SummaryFigure[] = [
    {
      id: "active",
      label: "Active / assigned",
      value: assets.isLoading ? "…" : activeCount,
      tone: "success",
    },
    {
      id: "maintenance",
      label: "Maintenance / out of service",
      value: assets.isLoading ? "…" : maintenanceCount,
      tone: maintenanceCount ? "warning" : "default",
    },
    {
      id: "attention",
      label: "Service or warranty due (30 days)",
      value: assets.isLoading ? "…" : attentionCount,
      tone: attentionCount ? "warning" : "default",
    },
    {
      id: "cost",
      label: "Acquisition cost",
      value: assets.isLoading ? "…" : money(totalCost, branding.currency),
      hint: "No depreciation posted",
    },
  ];

  const activeFilters: ActiveFilterChip[] = [];
  if (departmentFilter !== "all")
    activeFilters.push({
      id: "department",
      label: departmentName(departmentFilter),
      onClear: () => setDepartmentFilter("all"),
    });
  if (statusFilter !== "all")
    activeFilters.push({ id: "status", label: titleCase(statusFilter), onClear: () => setStatusFilter("all") });
  if (conditionFilter !== "all")
    activeFilters.push({
      id: "condition",
      label: titleCase(conditionFilter),
      onClear: () => setConditionFilter("all"),
    });
  const clearAll = () => {
    setDepartmentFilter("all");
    setStatusFilter("all");
    setConditionFilter("all");
  };

  const inspected = filtered.find((r) => r["id"] === inspectId) ?? null;
  const movements = useAssetMovements(inspected?.["id"] as string | undefined);
  const serviceHistory = useAssetServiceHistory(inspected?.["id"] as string | undefined);
  const workOrders = useAssetWorkOrders(inspected?.["id"] as string | undefined);
  const tagPrefixes = useAssetTagPrefixes(allRows);

  const snapshot = useMemo(() => ({ ...editing }), [editing]);
  const { dirty, setBaseline, markSaved } = useDirtyForm(snapshot, { enabled: Boolean(editing.id) });

  const openNewAsset = () => {
    const blank = { ...BLANK_ASSET };
    setEditing(blank);
    setBaseline(blank);
    setAssetDialog(true);
  };

  const openEditAsset = (row: Row) => {
    const values: EditingAsset = {
      id: row["id"] as string,
      asset_tag: (row["asset_tag"] as string) ?? "",
      name: (row["name"] as string) ?? "",
      description: (row["description"] as string) ?? "",
      category_id: (row["category_id"] as string) ?? "",
      serial_number: (row["serial_number"] as string) ?? "",
      model: (row["model"] as string) ?? "",
      manufacturer: (row["manufacturer"] as string) ?? "",
      quantity: String(row["quantity"] ?? 1),
      purchase_date: (row["purchase_date"] as string) ?? "",
      purchase_cost: row["purchase_cost"] != null ? String(row["purchase_cost"]) : "",
      supplier_id: (row["supplier_id"] as string) ?? "",
      purchase_reference: (row["purchase_reference"] as string) ?? "",
      warranty_start: (row["warranty_start"] as string) ?? "",
      warranty_expiry: (row["warranty_expiry"] as string) ?? "",
      location_label: (row["location_label"] as string) ?? "",
      room_id: (row["room_id"] as string) ?? "",
      department_id: (row["department_id"] as string) ?? "",
      custodian_id: (row["custodian_id"] as string) ?? "",
      condition: (row["condition"] as string) ?? "good",
      status: (row["status"] as string) ?? "active",
      criticality: (row["criticality"] as string) ?? "normal",
    };
    setEditing(values);
    setBaseline(values);
    setAssetDialog(true);
  };

  const submitAsset = () => {
    const payload: Row = {
      asset_tag: editing.asset_tag || null,
      name: editing.name,
      description: editing.description || null,
      category_id: editing.category_id || null,
      serial_number: editing.serial_number || null,
      model: editing.model || null,
      manufacturer: editing.manufacturer || null,
      quantity: Number(editing.quantity) || 1,
      purchase_date: editing.purchase_date || null,
      purchase_cost: editing.purchase_cost ? Number(editing.purchase_cost) : null,
      supplier_id: editing.supplier_id || null,
      purchase_reference: editing.purchase_reference || null,
      warranty_start: editing.warranty_start || null,
      warranty_expiry: editing.warranty_expiry || null,
      location_label: editing.location_label || null,
      room_id: editing.room_id || null,
      department_id: editing.department_id || null,
      custodian_id: editing.custodian_id || null,
      condition: editing.condition,
      status: editing.status,
      criticality: editing.criticality,
    };
    if (editing.id) payload["id"] = editing.id;
    if (!editing.id) payload["branch_id"] = writeBranchId;
    saveAsset.mutate(payload, {
      onSuccess: () => {
        markSaved();
        setAssetDialog(false);
      },
    });
  };

  const openTransfer = (row: Row) => {
    setTransferLocation((row["location_label"] as string) ?? "");
    setTransferDepartment((row["department_id"] as string) ?? "");
    setTransferCustodian((row["custodian_id"] as string) ?? "");
    setTransferReason("");
    setTransferDialog(true);
  };

  const submitTransfer = () => {
    if (!inspected) return;
    moveAsset.mutate(
      {
        asset: inspected,
        newLocation: transferLocation,
        newCustodian: transferCustodian || null,
        newDepartmentId: transferDepartment || null,
        reason: transferReason,
      },
      { onSuccess: () => setTransferDialog(false) },
    );
  };

  const openStatusChange = (row: Row) => {
    setNextStatus((row["status"] as string) ?? "active");
    setStatusReason("");
    setStatusDialog(true);
  };

  const submitStatus = () => {
    if (!inspected) return;
    setStatus.mutate(
      { asset: inspected, status: nextStatus, reason: statusReason },
      { onSuccess: () => setStatusDialog(false) },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Maintenance"
        title="Assets & Equipment"
        description="Register fixed assets and managed equipment sets — custodian, location, condition, status and movement history."
        icon={Boxes}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" asChild>
              <Link to="/admin/asset-categories">Categories</Link>
            </Button>
            {manage ? (
              <>
                <Button variant="secondary" onClick={() => setImportOpen(true)}>
                  Import assets
                </Button>
                <Button onClick={openNewAsset}>New asset</Button>
              </>
            ) : null}
          </div>
        }
      />

      <ImportWizard
        domain={domainByKey("assets")!}
        entryPoint="assets_module"
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <CatalogueWorkspace
        rail={
          <CatalogueRail
            title="Categories"
            items={railItems}
            value={categoryRail}
            onChange={setCategoryRail}
            allLabel="All assets"
            allCount={rows.length}
          />
        }
      >
        <CatalogueQueryBar
          search={search}
          onSearch={setSearch}
          placeholder="Search asset, tag, serial or location"
          activeFilters={activeFilters}
          onClearAll={activeFilters.length ? clearAll : undefined}
          filters={
            <>
              <div className="space-y-1.5">
                <Label>Department</Label>
                <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
                  <SelectTrigger aria-label="Filter by department">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any department</SelectItem>
                    {departmentList.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger aria-label="Filter by status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any status</SelectItem>
                    {ASSET_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {titleCase(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Condition</Label>
                <Select value={conditionFilter} onValueChange={setConditionFilter}>
                  <SelectTrigger aria-label="Filter by condition">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any condition</SelectItem>
                    {ASSET_CONDITIONS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {titleCase(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          }
        />

        <QueryState
          isLoading={assets.isLoading}
          error={assets.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Boxes}
              title="No assets registered"
              description="Register furniture, kitchen equipment, IT gear or a managed set such as 120 dinner plates."
            />
          }
        >
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No assets match the current filters.
            </p>
          ) : (
            <div className="min-w-0">
              {grouped.map(([groupName, groupRows]) => (
                <CatalogueGroup key={groupName} label={groupName} count={groupRows.length}>
                  {groupRows.map((r) => (
                    <CatalogueRow
                      key={r["id"] as string}
                      selected={inspectId === r["id"]}
                      onOpen={() => setInspectId(r["id"] as string)}
                      title={r["name"] as string}
                      subtitle={
                        [r["asset_tag"], r["location_label"] ?? roomLabel(r["room_id"])]
                          .filter(Boolean)
                          .join(" · ") || undefined
                      }
                      chips={
                        <>
                          <StatusPill tone={statusTone(String(r["status"]))}>
                            {titleCase(String(r["status"]))}
                          </StatusPill>
                          <StatusPill tone={conditionTone(String(r["condition"]))}>
                            {titleCase(String(r["condition"]))}
                          </StatusPill>
                          {Number(r["quantity"]) > 1 ? (
                            <StatusPill tone="default">Qty {r["quantity"]}</StatusPill>
                          ) : null}
                        </>
                      }
                      trailing={
                        r["purchase_cost"] != null ? money(r["purchase_cost"], branding.currency) : undefined
                      }
                    />
                  ))}
                </CatalogueGroup>
              ))}
            </div>
          )}
        </QueryState>
      </CatalogueWorkspace>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(open) => {
          if (!open) setInspectId(null);
        }}
        title={(inspected?.["name"] as string) ?? ""}
        subtitle={
          inspected
            ? [inspected["asset_tag"], (inspected["asset_categories"] as Row | null)?.["name"]]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
        chips={
          inspected ? (
            <>
              <StatusPill tone={statusTone(String(inspected["status"]))}>
                {titleCase(String(inspected["status"]))}
              </StatusPill>
              <StatusPill tone={conditionTone(String(inspected["condition"]))}>
                {titleCase(String(inspected["condition"]))}
              </StatusPill>
            </>
          ) : null
        }
        footer={
          inspected && (manage || canTransfer) ? (
            <>
              {canTransfer ? (
                <Button variant="outline" onClick={() => openTransfer(inspected)}>
                  Transfer / assign
                </Button>
              ) : null}
              {manage ? (
                <>
                  <Button variant="outline" onClick={() => openStatusChange(inspected)}>
                    Change status
                  </Button>
                  <Button onClick={() => openEditAsset(inspected)}>Edit asset</Button>
                </>
              ) : null}
            </>
          ) : null
        }
        tabs={
          inspected
            ? [
                {
                  value: "overview",
                  label: "Overview",
                  content: (
                    <>
                      <InspectorSection title="Identity">
                        <InspectorField label="Asset tag">
                          {(inspected["asset_tag"] as string) || "Not set"}
                        </InspectorField>
                        <InspectorField label="Serial number">
                          {(inspected["serial_number"] as string) || "—"}
                        </InspectorField>
                        <InspectorField label="Manufacturer / model">
                          {[inspected["manufacturer"], inspected["model"]].filter(Boolean).join(" · ") || "—"}
                        </InspectorField>
                        <InspectorField label="Quantity">{String(inspected["quantity"] ?? 1)}</InspectorField>
                        <InspectorField label="Description">
                          {(inspected["description"] as string) || "—"}
                        </InspectorField>
                      </InspectorSection>
                      <InspectorSection title="Location & custody">
                        <InspectorField label="Location">
                          {(inspected["location_label"] as string) || roomLabel(inspected["room_id"]) || "—"}
                        </InspectorField>
                        <InspectorField label="Department">
                          {departmentName(inspected["department_id"])}
                        </InspectorField>
                        <InspectorField label="Custodian">
                          {custodianName(inspected)}
                        </InspectorField>
                        <InspectorField label="Criticality">
                          {titleCase(String(inspected["criticality"] ?? "normal"))}
                        </InspectorField>
                      </InspectorSection>
                      <InspectorSection title="Acquisition">
                        <InspectorField label="Purchase date">
                          {shortDate(inspected["purchase_date"])}
                        </InspectorField>
                        <InspectorField label="Purchase cost">
                          {inspected["purchase_cost"] != null
                            ? money(inspected["purchase_cost"], branding.currency)
                            : "—"}
                        </InspectorField>
                        <InspectorField label="Supplier">
                          {supplierList.find((s) => s["id"] === inspected["supplier_id"])?.["name"] as
                            | string
                            | undefined ?? "—"}
                        </InspectorField>
                        <InspectorField label="Purchase reference">
                          {(inspected["purchase_reference"] as string) || "—"}
                        </InspectorField>
                        <InspectorField label="Warranty">
                          {inspected["warranty_start"] || inspected["warranty_expiry"]
                            ? `${shortDate(inspected["warranty_start"])} → ${shortDate(inspected["warranty_expiry"])}`
                            : "—"}
                        </InspectorField>
                      </InspectorSection>
                    </>
                  ),
                },
                {
                  value: "movements",
                  label: "Movements",
                  content: (
                    <QueryState
                      isLoading={movements.isLoading}
                      error={movements.error}
                      isEmpty={(movements.data ?? []).length === 0}
                      empty={<EmptyState title="No movements recorded" description="Transfers, reassignments and status changes will appear here." />}
                    >
                      <ul className="divide-y divide-outline-subtle text-sm">
                        {(movements.data ?? []).map((m) => (
                          <li key={m["id"] as string} className="py-2.5">
                            <p className="font-medium">{titleCase(String(m["movement_type"]))}</p>
                            <p className="text-xs text-muted-foreground">
                              {(m["previous_location"] as string) || "—"} → {(m["new_location"] as string) || "—"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {(m["reason"] as string) || "No reason given"} · {shortDate(m["created_at"])}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </QueryState>
                  ),
                },
                {
                  value: "work-orders",
                  label: "Work orders",
                  content: (
                    <QueryState
                      isLoading={workOrders.isLoading}
                      error={workOrders.error}
                      isEmpty={(workOrders.data ?? []).length === 0}
                      empty={
                        <EmptyState
                          title="No work orders raised"
                          description="Work orders raised against this asset in Maintenance appear here — the same record, not a copy."
                        />
                      }
                    >
                      <ul className="divide-y divide-outline-subtle text-sm">
                        {(workOrders.data ?? []).map((w) => (
                          <li key={w["id"] as string} className="py-2.5">
                            <p className="font-medium">
                              {(w["work_order_number"] as string) || "Work order"} ·{" "}
                              {titleCase(String(w["status"] ?? ""))}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {(w["description"] as string) || "—"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Reported {shortDate(w["reported_at"])}
                              {w["completed_at"] ? ` · completed ${shortDate(w["completed_at"])}` : ""}
                              {w["actual_cost"] != null
                                ? ` · ${money(w["actual_cost"], branding.currency)}`
                                : ""}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </QueryState>
                  ),
                },
                {
                  value: "service",
                  label: "Service history",
                  content: (
                    <QueryState
                      isLoading={serviceHistory.isLoading}
                      error={serviceHistory.error}
                      isEmpty={(serviceHistory.data ?? []).length === 0}
                      empty={<EmptyState title="No service history" description="Preventive and reactive service visits linked from Maintenance will appear here." />}
                    >
                      <ul className="divide-y divide-outline-subtle text-sm">
                        {(serviceHistory.data ?? []).map((h) => (
                          <li key={h["id"] as string} className="py-2.5">
                            <p className="font-medium">{titleCase(String(h["service_type"]))}</p>
                            <p className="text-xs text-muted-foreground">
                              {(h["description"] as string) || "—"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {shortDate(h["service_date"])}
                              {h["cost"] != null ? ` · ${money(h["cost"], branding.currency)}` : ""}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </QueryState>
                  ),
                },
              ]
            : []
        }
      />

      <FormDialog
        open={assetDialog}
        onOpenChange={setAssetDialog}
        title={editing.id ? "Edit asset" : "New asset"}
        description="For a managed set (e.g. 120 dinner plates), record the quantity rather than one line per item."
        submitLabel={editing.id ? "Save changes" : "Register asset"}
        canSubmit={Boolean(editing.name.trim()) && (!editing.id || dirty)}
        busy={saveAsset.isPending}
        footerNote={editing.id && !dirty ? "No changes to save yet." : undefined}
        onSubmit={submitAsset}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="asset-name">Name</Label>
            <Input
              id="asset-name"
              value={editing.name}
              onChange={(e) => setEditing((prev) => ({ ...prev, name: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-tag">Asset tag</Label>
            <div className="flex gap-2">
              <Input
                id="asset-tag"
                value={editing.asset_tag}
                onChange={(e) => setEditing((prev) => ({ ...prev, asset_tag: e.target.value }))}
                placeholder={tagPrefixes[0] ? `${tagPrefixes[0]}-…` : "Enter or generate"}
              />
              {tagPrefixes.length ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={generatingTag}
                  onClick={() => {
                    setGeneratingTag(true);
                    proposeAssetTag(tagPrefixes[0]!)
                      .then((tag) => setEditing((prev) => ({ ...prev, asset_tag: tag })))
                      .catch((error: Error) => toast.error(error.message))
                      .finally(() => setGeneratingTag(false));
                  }}
                >
                  {generatingTag ? "…" : "Generate"}
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {tagPrefixes.length
                ? `Continues the ${tagPrefixes[0]} series already in the register.`
                : "No tag series exists yet — the first tag you type sets the pattern."}
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="asset-description">Description</Label>
            <Textarea
              id="asset-description"
              value={editing.description}
              onChange={(e) => setEditing((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select
              value={editing.category_id || "none"}
              onValueChange={(v) => setEditing((prev) => ({ ...prev, category_id: v === "none" ? "" : v }))}
            >
              <SelectTrigger aria-label="Asset category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Uncategorised</SelectItem>
                {categoryList.map((c) => (
                  <SelectItem key={c["id"] as string} value={c["id"] as string}>
                    {c["name"] as string}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-quantity">Quantity</Label>
            <Input
              id="asset-quantity"
              type="number"
              min="1"
              step="1"
              value={editing.quantity}
              onChange={(e) => setEditing((prev) => ({ ...prev, quantity: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-serial">Serial number</Label>
            <Input
              id="asset-serial"
              value={editing.serial_number}
              onChange={(e) => setEditing((prev) => ({ ...prev, serial_number: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-model">Model</Label>
            <Input
              id="asset-model"
              value={editing.model}
              onChange={(e) => setEditing((prev) => ({ ...prev, model: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-manufacturer">Manufacturer</Label>
            <Input
              id="asset-manufacturer"
              value={editing.manufacturer}
              onChange={(e) => setEditing((prev) => ({ ...prev, manufacturer: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-purchase-date">Purchase date</Label>
            <NeoDatePicker
              id="asset-purchase-date"
              value={editing.purchase_date}
              onChange={(v) => setEditing((prev) => ({ ...prev, purchase_date: v }))}
              quick={["today"]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-cost">Purchase cost</Label>
            <Input
              id="asset-cost"
              type="number"
              min="0"
              step="0.01"
              value={editing.purchase_cost}
              onChange={(e) => setEditing((prev) => ({ ...prev, purchase_cost: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Supplier</Label>
            <Select
              value={editing.supplier_id || "none"}
              onValueChange={(v) => setEditing((prev) => ({ ...prev, supplier_id: v === "none" ? "" : v }))}
            >
              <SelectTrigger aria-label="Supplier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not recorded</SelectItem>
                {supplierList.map((s) => (
                  <SelectItem key={s["id"] as string} value={s["id"] as string}>
                    {s["name"] as string}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-reference">Purchase reference</Label>
            <Input
              id="asset-reference"
              value={editing.purchase_reference}
              onChange={(e) => setEditing((prev) => ({ ...prev, purchase_reference: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-warranty-start">Warranty start</Label>
            <NeoDatePicker
              id="asset-warranty-start"
              value={editing.warranty_start}
              onChange={(v) => setEditing((prev) => ({ ...prev, warranty_start: v }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-warranty-expiry">Warranty expiry</Label>
            <NeoDatePicker
              id="asset-warranty-expiry"
              value={editing.warranty_expiry}
              onChange={(v) => setEditing((prev) => ({ ...prev, warranty_expiry: v }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-location">Location</Label>
            <Input
              id="asset-location"
              value={editing.location_label}
              onChange={(e) => setEditing((prev) => ({ ...prev, location_label: e.target.value }))}
              placeholder="e.g. Main Store, Room 204"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Room</Label>
            <Select
              value={editing.room_id || "none"}
              onValueChange={(v) => setEditing((prev) => ({ ...prev, room_id: v === "none" ? "" : v }))}
            >
              <SelectTrigger aria-label="Room">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not room-linked</SelectItem>
                {roomList.map((r) => (
                  <SelectItem key={r["id"] as string} value={r["id"] as string}>
                    {r["room_number"] as string}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select
              value={editing.department_id || "none"}
              onValueChange={(v) =>
                setEditing((prev) => ({
                  ...prev,
                  department_id: v === "none" ? "" : v,
                  custodian_id: "",
                }))
              }
            >
              <SelectTrigger aria-label="Department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {departmentList.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Custodian</Label>
            <Select
              value={editing.custodian_id || "none"}
              onValueChange={(v) =>
                setEditing((prev) => ({
                  ...prev,
                  custodian_id: v === "none" ? "" : v,
                }))
              }
              disabled={!editing.department_id}
            >
              <SelectTrigger aria-label="Custodian">
                <SelectValue
                  placeholder={editing.department_id ? "Select custodian" : "Select department first"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {editingWorkerList.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Condition</Label>
            <Select
              value={editing.condition}
              onValueChange={(v) => setEditing((prev) => ({ ...prev, condition: v }))}
            >
              <SelectTrigger aria-label="Condition">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_CONDITIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={editing.status} onValueChange={(v) => setEditing((prev) => ({ ...prev, status: v }))}>
              <SelectTrigger aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Criticality</Label>
            <Select
              value={editing.criticality}
              onValueChange={(v) => setEditing((prev) => ({ ...prev, criticality: v }))}
            >
              <SelectTrigger aria-label="Criticality">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["low", "normal", "high", "critical"].map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FormDialog>

      <FormDialog
        open={transferDialog}
        onOpenChange={setTransferDialog}
        title="Transfer / assign asset"
        description="Records a movement in the audit trail and updates the asset's current location, department and custodian."
        submitLabel="Record transfer"
        canSubmit={Boolean(transferLocation.trim() && transferReason.trim())}
        busy={moveAsset.isPending}
        onSubmit={submitTransfer}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="transfer-location">New location</Label>
            <Input
              id="transfer-location"
              value={transferLocation}
              onChange={(e) => setTransferLocation(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select
              value={transferDepartment || "none"}
              onValueChange={(v) => {
                setTransferDepartment(v === "none" ? "" : v);
                setTransferCustodian("");
              }}
            >
              <SelectTrigger aria-label="New department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unchanged</SelectItem>
                {departmentList.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Custodian</Label>
            <Select
              value={transferCustodian || "none"}
              onValueChange={(v) => setTransferCustodian(v === "none" ? "" : v)}
              disabled={!transferDepartment}
            >
              <SelectTrigger aria-label="New custodian">
                <SelectValue
                  placeholder={transferDepartment ? "Select custodian" : "Select department first"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {transferWorkerList.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="transfer-reason">Reason</Label>
            <Textarea
              id="transfer-reason"
              value={transferReason}
              onChange={(e) => setTransferReason(e.target.value)}
              required
            />
          </div>
        </div>
      </FormDialog>

      <FormDialog
        open={statusDialog}
        onOpenChange={setStatusDialog}
        title="Change asset status"
        description="A reason is required and is kept in the asset's movement history."
        submitLabel="Update status"
        canSubmit={Boolean(statusReason.trim())}
        busy={setStatus.isPending}
        onSubmit={submitStatus}
      >
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={nextStatus} onValueChange={setNextStatus}>
              <SelectTrigger aria-label="New status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_STATUSES.filter((s) =>
                  isAssetStatusTransitionAllowed(String(inspected?.["status"] ?? ""), s),
                ).map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {inspected &&
            !isAssetStatusTransitionAllowed(String(inspected["status"] ?? ""), "active") ? (
              <p className="text-xs text-muted-foreground">
                This asset has left the estate. Its record stays as history — register a replacement
                instead of returning it to service.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="status-reason">Reason</Label>
            <Textarea
              id="status-reason"
              value={statusReason}
              onChange={(e) => setStatusReason(e.target.value)}
              required
            />
          </div>
        </div>
      </FormDialog>
    </div>
  );
}

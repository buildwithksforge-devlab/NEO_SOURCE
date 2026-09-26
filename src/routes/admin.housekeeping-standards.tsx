/**
 * Cleaning Standards — the hotel's own room-cleaning SOPs.
 *
 * A standard is a named checklist for one kind of clean (departure, stay-over,
 * deep clean, turndown or anything the hotel defines itself), optionally
 * narrowed to one property or room type. When a cleaning job is raised, NEØ
 * picks the closest matching standard and freezes a copy of it on the job, so
 * later edits here never rewrite cleaning evidence already recorded.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList, Pencil, Plus, Trash2 } from "lucide-react";

import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { FormDialog } from "@/components/common/FormDialog";
import { FieldGrid } from "@/components/common/FormFields";
import { InspectorSheet, InspectorSection } from "@/components/common/InspectorSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { useWriteBranchId } from "@/lib/branch-filter";
import {
  useChecklistItems,
  useChecklistTemplates,
  useDeleteChecklistItem,
  useSaveChecklistItem,
  useSaveChecklistTemplate,
} from "@/lib/operations-data";
import { useRoomTypes } from "@/lib/pms-data";
import { titleCase } from "@/lib/operations";

type Row = Record<string, unknown>;

/** The cleaning types the housekeeping workflow can raise a job for. */
const CLEANING_TYPES = [
  { value: "any", label: "Any clean (fallback standard)" },
  { value: "checkout-cleaning", label: "Departure / checkout cleaning" },
  { value: "stayover-cleaning", label: "Stay-over cleaning" },
  { value: "deep-cleaning", label: "Deep cleaning" },
  { value: "turndown", label: "Turndown" },
  { value: "touch-up", label: "Touch-up" },
  { value: "rework", label: "Rework after a failed inspection" },
  { value: "recovery", label: "Recovery clean" },
];

const APPLIES_TO = [
  { value: "cleaning", label: "Cleaning only" },
  { value: "inspection", label: "Supervisor inspection only" },
  { value: "both", label: "Cleaning and inspection" },
];

export const Route = createFileRoute("/admin/housekeeping-standards")({
  head: () => ({
    meta: [
      { title: "Cleaning Standards — Configuration Centre" },
      {
        name: "description",
        content:
          "The hotel's own room-cleaning checklists for departure, stay-over, deep cleaning and turndown, and what a supervisor inspects.",
      },
      { property: "og:title", content: "Cleaning Standards — Configuration Centre" },
      {
        property: "og:description",
        content: "Configure the checklist an attendant must complete for each kind of room clean.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CleaningStandardsPage,
});

const emptyTemplate = {
  name: "",
  description: "",
  cleaning_type: "checkout-cleaning",
  area_scope: "room",
  room_type_id: "",
  property: "all",
  requires_inspection: true,
  active: true,
};

const emptyItem = {
  label: "",
  instructions: "",
  applies_to: "cleaning",
  mandatory: true,
  requires_comment: false,
  requires_photo: false,
  allows_defect: true,
  sort_order: 0,
};

function CleaningStandardsPage() {
  const { can } = useAuth();
  const branchId = useWriteBranchId();
  const canEdit =
    can("housekeeping", "checklists", "edit") ||
    can("housekeeping", "checklists", "create") ||
    can("administration", "workspace", "edit");

  const templates = useChecklistTemplates();
  const roomTypes = useRoomTypes();
  const saveTemplate = useSaveChecklistTemplate();
  const saveItem = useSaveChecklistItem();
  const deleteItem = useDeleteChecklistItem();

  const [selected, setSelected] = useState<Row | null>(null);
  const [templateForm, setTemplateForm] = useState<Row | null>(null);
  const [itemForm, setItemForm] = useState<Row | null>(null);

  const items = useChecklistItems(selected ? String(selected["id"]) : null);
  const itemRows = (items.data ?? []) as Row[];
  const rows = (templates.data ?? []) as Row[];

  const roomTypeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of (roomTypes.data ?? []) as Row[]) map.set(String(t["id"]), String(t["name"]));
    return map;
  }, [roomTypes.data]);

  const openTemplate = (row?: Row) =>
    setTemplateForm(
      row
        ? {
            ...emptyTemplate,
            ...row,
            description: row["description"] ?? "",
            room_type_id: row["room_type_id"] ?? "",
            property: row["branch_id"] ? "this" : "all",
          }
        : { ...emptyTemplate },
    );

  const submitTemplate = () => {
    if (!templateForm) return;
    const { property, ...values } = templateForm;
    saveTemplate.mutate(
      {
        ...(templateForm["id"] ? { id: String(templateForm["id"]) } : {}),
        name: String(values["name"] ?? "").trim(),
        description: String(values["description"] ?? "").trim() || null,
        cleaning_type: String(values["cleaning_type"] ?? "any"),
        area_scope: String(values["area_scope"] ?? "room"),
        room_type_id: values["room_type_id"] ? String(values["room_type_id"]) : null,
        branch_id: property === "this" ? branchId : null,
        requires_inspection: Boolean(values["requires_inspection"]),
        active: Boolean(values["active"]),
      },
      { onSuccess: () => setTemplateForm(null) },
    );
  };

  const submitItem = () => {
    if (!itemForm || !selected) return;
    saveItem.mutate(
      {
        ...(itemForm["id"] ? { id: String(itemForm["id"]) } : {}),
        template_id: String(selected["id"]),
        label: String(itemForm["label"] ?? "").trim(),
        instructions: String(itemForm["instructions"] ?? "").trim() || null,
        applies_to: String(itemForm["applies_to"] ?? "cleaning"),
        response_type: "check",
        mandatory: Boolean(itemForm["mandatory"]),
        requires_comment: Boolean(itemForm["requires_comment"]),
        requires_photo: Boolean(itemForm["requires_photo"]),
        allows_defect: Boolean(itemForm["allows_defect"]),
        sort_order: Number(itemForm["sort_order"] ?? 0),
      },
      { onSuccess: () => setItemForm(null) },
    );
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Housekeeping"
        title="Cleaning Standards"
        description="What must actually be done during each kind of room clean, and what the supervisor checks before the room goes back on sale. Every cleaning job keeps a copy of the standard that applied to it."
        actions={
          canEdit ? (
            <Button onClick={() => openTemplate()}>
              <Plus className="mr-2 h-4 w-4" /> New standard
            </Button>
          ) : null
        }
      />

      <SectionCard
        title="Cleaning standards"
        description="A standard is matched to a job by cleaning type first, then room type, then property."
      >
        <QueryState
          isLoading={templates.isLoading}
          error={templates.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No cleaning standard configured"
              description="Until a standard exists, cleaning jobs are raised with no checklist and attendants have nothing to record. Create your first standard to set the hotel's room-cleaning SOP."
            />
          }
        >
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li
                key={String(row["id"])}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <button
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() => setSelected(row)}
                >
                  <p className="text-sm font-medium">{String(row["name"] ?? "Untitled")}</p>
                  <p className="text-xs text-muted-foreground">
                    {titleCase(String(row["cleaning_type"] ?? "any").replace(/-/g, " "))}
                    {row["room_type_id"]
                      ? ` · ${roomTypeName.get(String(row["room_type_id"])) ?? "Room type"}`
                      : " · All room types"}
                    {row["branch_id"] ? " · This property" : " · All properties"}
                    {` · v${String(row["version"] ?? 1)}`}
                  </p>
                </button>
                <div data-action-cluster className="flex items-center gap-2">
                  {row["requires_inspection"] ? (
                    <Badge variant="secondary">Inspection required</Badge>
                  ) : null}
                  <Badge variant={row["active"] ? "default" : "outline"}>
                    {row["active"] ? "Active" : "Inactive"}
                  </Badge>
                  <Button size="sm" variant="outline" onClick={() => setSelected(row)}>
                    <ClipboardList className="mr-2 h-4 w-4" /> Steps
                  </Button>
                  {canEdit ? (
                    <Button size="sm" variant="ghost" onClick={() => openTemplate(row)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      <InspectorSheet
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={String(selected?.["name"] ?? "Cleaning standard")}
        subtitle={
          selected
            ? `${titleCase(String(selected["cleaning_type"] ?? "any").replace(/-/g, " "))} · version ${String(selected["version"] ?? 1)}`
            : undefined
        }
      >
        <InspectorSection
          title="Checklist steps"
          actions={
            canEdit ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setItemForm({ ...emptyItem, sort_order: (itemRows.length + 1) * 10 })
                }
              >
                <Plus className="mr-2 h-4 w-4" /> Add step
              </Button>
            ) : null
          }
        >
          <QueryState
            isLoading={items.isLoading}
            error={items.error}
            isEmpty={itemRows.length === 0}
            empty={
              <EmptyState
                title="No steps yet"
                description="Add the steps an attendant must complete. Required steps must be recorded before a room can be sent for inspection."
              />
            }
          >
            <ul className="divide-y divide-border">
              {itemRows.map((item) => (
                <li key={String(item["id"])} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {String(item["label"])}
                      {item["mandatory"] ? <span className="ml-1 text-destructive">*</span> : null}
                    </p>
                    {item["instructions"] ? (
                      <p className="text-xs text-muted-foreground">{String(item["instructions"])}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {APPLIES_TO.find((a) => a.value === String(item["applies_to"] ?? "cleaning"))
                        ?.label ?? "Cleaning only"}
                      {item["requires_comment"] ? " · comment required" : ""}
                      {item["requires_photo"] ? " · photo expected" : ""}
                    </p>
                  </div>
                  {canEdit ? (
                    <div data-action-cluster className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setItemForm({ ...item })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteItem.mutate(String(item["id"]))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </QueryState>
        </InspectorSection>
      </InspectorSheet>

      <FormDialog
        open={Boolean(templateForm)}
        onOpenChange={(open) => !open && setTemplateForm(null)}
        title={templateForm?.["id"] ? "Edit cleaning standard" : "New cleaning standard"}
        description="Name the standard, say which clean it applies to and whether a supervisor must inspect the room afterwards."
        submitLabel="Save standard"
        busy={saveTemplate.isPending}
        canSubmit={Boolean(String(templateForm?.["name"] ?? "").trim())}
        onSubmit={submitTemplate}
      >
        <FieldGrid>
          <div className="space-y-2">
            <Label htmlFor="std-name">Standard name</Label>
            <Input
              id="std-name"
              value={String(templateForm?.["name"] ?? "")}
              onChange={(e) =>
                setTemplateForm((f) => ({ ...(f ?? {}), name: e.target.value }))
              }
              placeholder="Departure clean"
            />
          </div>
          <div className="space-y-2">
            <Label>Cleaning type</Label>
            <Select
              value={String(templateForm?.["cleaning_type"] ?? "any")}
              onValueChange={(v) => setTemplateForm((f) => ({ ...(f ?? {}), cleaning_type: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLEANING_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Room type</Label>
            <Select
              value={String(templateForm?.["room_type_id"] ?? "") || "all"}
              onValueChange={(v) =>
                setTemplateForm((f) => ({ ...(f ?? {}), room_type_id: v === "all" ? "" : v }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All room types</SelectItem>
                {((roomTypes.data ?? []) as Row[]).map((t) => (
                  <SelectItem key={String(t["id"])} value={String(t["id"])}>
                    {String(t["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Applies to</Label>
            <Select
              value={String(templateForm?.["property"] ?? "all")}
              onValueChange={(v) => setTemplateForm((f) => ({ ...(f ?? {}), property: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All properties</SelectItem>
                <SelectItem value="this" disabled={!branchId}>
                  The selected property only
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </FieldGrid>
        <div className="space-y-2">
          <Label htmlFor="std-description">Description</Label>
          <Textarea
            id="std-description"
            value={String(templateForm?.["description"] ?? "")}
            onChange={(e) =>
              setTemplateForm((f) => ({ ...(f ?? {}), description: e.target.value }))
            }
            placeholder="What this standard covers and when it is used."
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Supervisor inspection required</p>
            <p className="text-xs text-muted-foreground">
              The room waits for an inspection before it can be sold again.
            </p>
          </div>
          <Switch
            checked={Boolean(templateForm?.["requires_inspection"])}
            onCheckedChange={(v) =>
              setTemplateForm((f) => ({ ...(f ?? {}), requires_inspection: v }))
            }
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Active</p>
            <p className="text-xs text-muted-foreground">
              Inactive standards are never matched to new cleaning jobs. Jobs already raised keep
              their copy.
            </p>
          </div>
          <Switch
            checked={Boolean(templateForm?.["active"])}
            onCheckedChange={(v) => setTemplateForm((f) => ({ ...(f ?? {}), active: v }))}
          />
        </div>
      </FormDialog>

      <FormDialog
        open={Boolean(itemForm)}
        onOpenChange={(open) => !open && setItemForm(null)}
        title={itemForm?.["id"] ? "Edit step" : "Add step"}
        description="One thing the attendant must do, or the supervisor must check."
        submitLabel="Save step"
        size="md"
        busy={saveItem.isPending}
        canSubmit={Boolean(String(itemForm?.["label"] ?? "").trim())}
        onSubmit={submitItem}
      >
        <div className="space-y-2">
          <Label htmlFor="item-label">Step</Label>
          <Input
            id="item-label"
            value={String(itemForm?.["label"] ?? "")}
            onChange={(e) => setItemForm((f) => ({ ...(f ?? {}), label: e.target.value }))}
            placeholder="Strip and remake the bed"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="item-instructions">Instructions</Label>
          <Textarea
            id="item-instructions"
            value={String(itemForm?.["instructions"] ?? "")}
            onChange={(e) => setItemForm((f) => ({ ...(f ?? {}), instructions: e.target.value }))}
            placeholder="How this hotel wants it done."
          />
        </div>
        <FieldGrid>
          <div className="space-y-2">
            <Label>Used for</Label>
            <Select
              value={String(itemForm?.["applies_to"] ?? "cleaning")}
              onValueChange={(v) => setItemForm((f) => ({ ...(f ?? {}), applies_to: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPLIES_TO.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="item-order">Order</Label>
            <Input
              id="item-order"
              type="number"
              value={String(itemForm?.["sort_order"] ?? 0)}
              onChange={(e) =>
                setItemForm((f) => ({ ...(f ?? {}), sort_order: Number(e.target.value) }))
              }
            />
          </div>
        </FieldGrid>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Required</p>
            <p className="text-xs text-muted-foreground">
              The room cannot be sent for inspection until this step is recorded.
            </p>
          </div>
          <Switch
            checked={Boolean(itemForm?.["mandatory"])}
            onCheckedChange={(v) => setItemForm((f) => ({ ...(f ?? {}), mandatory: v }))}
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Comment required</p>
            <p className="text-xs text-muted-foreground">
              The attendant must write a note against this step.
            </p>
          </div>
          <Switch
            checked={Boolean(itemForm?.["requires_comment"])}
            onCheckedChange={(v) => setItemForm((f) => ({ ...(f ?? {}), requires_comment: v }))}
          />
        </div>
      </FormDialog>
    </div>
  );
}

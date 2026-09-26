import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Wrench } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DeliveryGuard, EmptyState, QueryState } from "@/components/delivery/DeliveryGuard";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/pos";
import {
  FAULT_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  str,
  useCreateDeliveryMaintenanceRequest,
  useDeliveryMaintenanceRequests,
  type DeliveryRow,
} from "@/lib/delivery-department";

export const Route = createFileRoute("/_shell/delivery/maintenance")({
  head: () => ({
    meta: [
      { title: "Delivery Fleet & Equipment Maintenance — NEØ" },
      {
        name: "description",
        content:
          "Report and track faults on delivery motorcycles, vehicles, delivery boxes and rider equipment. Maintenance owns the repair.",
      },
      { property: "og:title", content: "Delivery Fleet & Equipment Maintenance — NEØ" },
      {
        property: "og:description",
        content:
          "Raise delivery vehicle and equipment faults and follow each repair through to completion.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DeliveryGuard action="maintenance.view">
      <DeliveryMaintenancePage />
    </DeliveryGuard>
  ),
});

const TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  completed: "success",
  closed: "success",
  verified: "success",
  "in-progress": "warning",
  assigned: "warning",
  reported: "warning",
  open: "warning",
  cancelled: "destructive",
};

const OPEN_STATUSES = ["completed", "closed", "cancelled", "verified"];

function DeliveryMaintenancePage() {
  const { can } = useAuth();
  const requests = useDeliveryMaintenanceRequests();
  const create = useCreateDeliveryMaintenanceRequest();
  const mayReport = can("delivery", "maintenance.create");

  const [open, setOpen] = useState(false);
  const [asset, setAsset] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [category, setCategory] = useState("motorcycle");
  const [lens, setLens] = useState<"none" | "open" | "urgent">("none");
  const [inspectId, setInspectId] = useState<string | null>(null);

  const rows = (requests.data ?? []) as DeliveryRow[];
  const openRows = rows.filter((r) => !OPEN_STATUSES.includes(String(r["status"])));
  const urgentRows = rows.filter((r) => String(r["priority"]) === "urgent");

  const filtered = useMemo(() => {
    if (lens === "open") return openRows;
    if (lens === "urgent") return urgentRows;
    return rows;
  }, [rows, openRows, urgentRows, lens]);

  const inspected = rows.find((r) => String(r["id"]) === inspectId) ?? null;

  const toggleLens = (next: "open" | "urgent") =>
    setLens((prev) => (prev === next ? "none" : next));

  const leadFigure: SummaryFigure = {
    id: "reported",
    label: "Reported (last 100)",
    value: rows.length,
    hint: "Most recent fault reports in scope",
  };
  const figures: SummaryFigure[] = [
    {
      id: "open",
      label: "Open with Maintenance",
      value: openRows.length,
      hint: "Faults not yet repaired or closed",
      tone: openRows.length ? "warning" : "success",
      onSelect: () => toggleLens("open"),
      active: lens === "open",
    },
    {
      id: "urgent",
      label: "Urgent",
      value: urgentRows.length,
      hint: "Raised at urgent priority",
      tone: urgentRows.length ? "destructive" : "default",
      onSelect: () => toggleLens("urgent"),
      active: lens === "urgent",
    },
  ];

  const submit = () =>
    create.mutate(
      { asset, description, priority, faultCategory: category },
      {
        onSuccess: () => {
          setOpen(false);
          setAsset("");
          setDescription("");
        },
      },
    );

  return (
    <div>
      <PageHeader
        eyebrow="Delivery Department"
        title="Fleet & Equipment Maintenance"
        icon={Wrench}
        description="Delivery reports the fault; Maintenance carries out the repair and closes it. Nothing is marked repaired from this screen."
        actions={
          mayReport ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Report a fault
            </Button>
          ) : null
        }
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <QueryState
        isLoading={requests.isLoading}
        error={requests.error}
        isEmpty={filtered.length === 0}
        empty={
          <EmptyState
            title="No faults reported"
            description="A rider reporting a puncture or a broken delivery box appears here for the Delivery Manager and Maintenance."
          />
        }
      >
        <div className="surface-quiet neo-contain flex min-w-0 flex-col gap-1.5 rounded-2xl p-1.5">
          {filtered.map((r) => {
            const status = str(r["status"], "reported");
            return (
              <button
                key={String(r["id"])}
                type="button"
                data-touch-target
                onClick={() => setInspectId(String(r["id"]))}
                className="surface-raised min-w-0 rounded-xl border border-outline-subtle p-3 text-left transition-colors hover:bg-muted/40"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <p className="neo-line-1 text-sm font-semibold">
                    {str(r["asset_label"] ?? r["asset"])}
                  </p>
                  <StatusPill tone={TONE[status] ?? "default"}>
                    {titleCase(status.replace(/-/g, " "))}
                  </StatusPill>
                </div>
                <p className="neo-line-1 mt-0.5 text-xs text-muted-foreground">
                  {str(r["work_order_number"] ?? r["reference"])}
                </p>
                <p className="neo-contain mt-1 text-sm text-muted-foreground">
                  {str(r["description"])}
                </p>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{titleCase(str(r["priority"], "medium"))} priority</span>
                  <span>
                    {r["created_at"] ? new Date(String(r["created_at"])).toLocaleDateString() : "—"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </QueryState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a delivery fault</DialogTitle>
            <DialogDescription>
              This raises a maintenance work order owned by the Maintenance team.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="asset">Asset</Label>
              <Input
                id="asset"
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                placeholder="e.g. Motorcycle KDD 123A, Delivery box 4"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FAULT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {titleCase(c.replace(/-/g, " "))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MAINTENANCE_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="fault">What is wrong</Label>
              <Textarea
                id="fault"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the fault and whether the asset is still usable"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={create.isPending || !asset.trim() || !description.trim()}
            >
              Raise request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(o) => !o && setInspectId(null)}
        title={inspected ? str(inspected["asset_label"] ?? inspected["asset"]) : "Fault"}
        subtitle={inspected ? str(inspected["work_order_number"] ?? inspected["reference"]) : undefined}
        chips={
          inspected ? (
            <StatusPill tone={TONE[str(inspected["status"], "reported")] ?? "default"}>
              {titleCase(str(inspected["status"], "reported").replace(/-/g, " "))}
            </StatusPill>
          ) : undefined
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Fault">
              <p className="text-sm text-foreground">{str(inspected["description"])}</p>
            </InspectorSection>
            <InspectorSection title="Details">
              <InspectorField label="Category">
                {titleCase(str(inspected["fault_category"] ?? inspected["category"], "vehicle").replace(/-/g, " "))}
              </InspectorField>
              <InspectorField label="Priority">
                {titleCase(str(inspected["priority"], "medium"))}
              </InspectorField>
              <InspectorField label="Reported">
                {inspected["created_at"]
                  ? new Date(String(inspected["created_at"])).toLocaleString()
                  : "—"}
              </InspectorField>
            </InspectorSection>
          </>
        ) : null}
      </InspectorSheet>
    </div>
  );
}

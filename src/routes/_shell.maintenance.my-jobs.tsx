import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { titleCase } from "@/lib/operations";
import {
  JOB_STAGES,
  maintStr,
  useAdvanceMaintenanceJob,
  useIssuableStockForJob,
  useMyMaintenanceJobs,
  useConsumeStockPart,
  useRecordJobMaterials,
  useWorkOrderParts,
  type MaintRow,
} from "@/lib/maintenance-department";

export const Route = createFileRoute("/_shell/maintenance/my-jobs")({
  head: () => ({
    meta: [
      { title: "My Maintenance Jobs — NEØ" },
      {
        name: "description",
        content:
          "Accept, start, diagnose and complete the maintenance work orders assigned to you, and record the materials used.",
      },
      { property: "og:title", content: "My Maintenance Jobs — NEØ" },
      {
        property: "og:description",
        content:
          "The technician's own job list: accept, diagnose, record materials and hand the job back for checking.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="maintenance" action="my-jobs.view">
      <MyJobsPage />
    </OpsGuard>
  ),
});

const TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  completed: "success",
  verified: "success",
  closed: "success",
  "in-progress": "warning",
  accepted: "warning",
  assigned: "warning",
  "on-hold": "destructive",
  reported: "default",
};

function MyJobsPage() {
  const jobs = useMyMaintenanceJobs();
  const advance = useAdvanceMaintenanceJob();
  const record = useRecordJobMaterials();
  const consume = useConsumeStockPart();

  const [active, setActive] = useState<MaintRow | null>(null);
  const [status, setStatus] = useState<string>("accepted");
  const [diagnosis, setDiagnosis] = useState("");
  const [note, setNote] = useState("");
  const [material, setMaterial] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [partPick, setPartPick] = useState("");
  const [partQty, setPartQty] = useState("1");
  // One reference per entry, so a repeated tap cannot issue the part twice.
  const [partKey, setPartKey] = useState(() => crypto.randomUUID());

  const parts = useWorkOrderParts(active ? String(active["id"]) : null);
  const issuable = useIssuableStockForJob(active ? String(active["id"]) : null);
  const options = issuable.data ?? [];
  const picked = options.find((o) => `${o.stock_item_id}:${o.location_id}` === partPick) ?? null;
  const rows = (jobs.data ?? []) as MaintRow[];
  const openCount = rows.filter(
    (r) => !["completed", "verified", "closed"].includes(String(r["status"])),
  ).length;

  const open = (row: MaintRow) => {
    setActive(row);
    setStatus(
      String(row["status"]) === "reported" || String(row["status"]) === "assigned"
        ? "accepted"
        : "in-progress",
    );
    setDiagnosis(String(row["diagnosis"] ?? ""));
    setNote("");
  };

  return (
    <div>
      <PageHeader
        eyebrow="Maintenance Department"
        title="My jobs"
        description="Work assigned to you. You record what you found and what you did — verification and closure stay with the Maintenance Manager."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="Open with me">
          <p className="text-3xl font-semibold">{openCount}</p>
        </SectionCard>
        <SectionCard title="Urgent">
          <p className="text-3xl font-semibold">
            {
              rows.filter((r) => ["urgent", "critical", "high"].includes(String(r["priority"])))
                .length
            }
          </p>
        </SectionCard>
        <SectionCard title="Assigned (last 200)">
          <p className="text-3xl font-semibold">{rows.length}</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Assigned work orders"
        description="Faults raised by other departments and routed to you."
      >
        <QueryState
          isLoading={jobs.isLoading}
          error={jobs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="Nothing assigned to you"
              description="When the Maintenance Manager assigns a work order to you it appears here."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Fault</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={String(r["id"])}>
                    <TableCell className="font-medium">
                      {maintStr(r["work_order_number"])}
                    </TableCell>
                    <TableCell className="max-w-sm text-sm text-muted-foreground">
                      {maintStr(r["description"])}
                    </TableCell>
                    <TableCell>{maintStr(r["location_label"])}</TableCell>
                    <TableCell>{titleCase(maintStr(r["priority"], "normal"))}</TableCell>
                    <TableCell>
                      <StatusPill tone={TONE[String(r["status"] ?? "")] ?? "default"}>
                        {titleCase(maintStr(r["status"], "reported").replace(/-/g, " "))}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => open(r)}>
                        Update
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <Dialog open={active !== null} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{maintStr(active?.["work_order_number"], "Work order")}</DialogTitle>
            <DialogDescription>{maintStr(active?.["description"])}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Progress</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {JOB_STAGES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s.replace(/-/g, " "))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="diagnosis">Diagnosis / what you found</Label>
              <Textarea
                id="diagnosis"
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="note">Work note</Label>
              <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>

            {/* Taking a part off the shelf is a stores movement, not a note.
                This issues the item so the stock figure, the job cost and the
                maintenance record all agree. */}
            <div className="rounded-lg border border-border p-3">
              <p className="mb-2 text-sm font-medium">Take a part from stores</p>
              {issuable.isLoading ? (
                <p className="text-xs text-muted-foreground">Checking what the stores hold…</p>
              ) : options.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No stock is held for this property yet. Record what you used below, or ask the
                  Maintenance Manager for the material.
                </p>
              ) : (
                <>
                  <Select value={partPick} onValueChange={setPartPick}>
                    <SelectTrigger>
                      <SelectValue placeholder="Part and store" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((o) => (
                        <SelectItem
                          key={`${o.stock_item_id}:${o.location_id}`}
                          value={`${o.stock_item_id}:${o.location_id}`}
                        >
                          {o.item_name} — {o.location_name} ({o.quantity_on_hand}{" "}
                          {o.base_unit ?? ""})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="mt-2 flex gap-2">
                    <Input
                      value={partQty}
                      onChange={(e) => setPartQty(e.target.value)}
                      type="number"
                      min="0.01"
                      step="0.01"
                      className="w-28"
                    />
                    <Button
                      variant="outline"
                      disabled={!active || consume.isPending || !picked || !(Number(partQty) > 0)}
                      onClick={() =>
                        active &&
                        picked &&
                        consume.mutate(
                          {
                            workOrderId: String(active["id"]),
                            stockItemId: picked.stock_item_id,
                            locationId: picked.location_id,
                            quantity: Number(partQty),
                            ...(picked.base_unit ? { unit: picked.base_unit } : {}),
                            idempotencyKey: partKey,
                          },
                          {
                            onSuccess: () => {
                              setPartPick("");
                              setPartQty("1");
                              setPartKey(crypto.randomUUID());
                            },
                          },
                        )
                      }
                    >
                      Issue from stores
                    </Button>
                  </div>
                </>
              )}
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="mb-2 text-sm font-medium">Materials used</p>
              <p className="mb-2 text-xs text-muted-foreground">
                For anything not held in stores — this records the material on the job only.
              </p>
              <div className="flex gap-2">
                <Input
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                  placeholder="e.g. Tap washer"
                  className="flex-1"
                />
                <Input
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  type="number"
                  min="0.01"
                  step="0.01"
                  className="w-24"
                />
                <Button
                  variant="outline"
                  disabled={!active || record.isPending || !material.trim()}
                  onClick={() =>
                    active &&
                    record.mutate(
                      {
                        workOrderId: String(active["id"]),
                        description: material,
                        quantity: Number(quantity) || 1,
                      },
                      { onSuccess: () => setMaterial("") },
                    )
                  }
                >
                  Record
                </Button>
              </div>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {(parts.data ?? []).map((p) => (
                  <li key={String(p["id"])}>
                    {maintStr(p["description"])} — {maintStr(p["quantity"], "0")}{" "}
                    {maintStr(p["unit"], "unit")}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActive(null)}>
              Close
            </Button>
            <Button
              disabled={!active || advance.isPending}
              onClick={() =>
                active &&
                advance.mutate(
                  { workOrderId: String(active["id"]), status, note, diagnosis },
                  { onSuccess: () => setActive(null) },
                )
              }
            >
              Save progress
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

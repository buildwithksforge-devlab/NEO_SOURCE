import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PackagePlus, ShieldAlert, WashingMachine, Wrench } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
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
import { Textarea } from "@/components/ui/textarea";
import { shortDateTime, titleCase } from "@/lib/operations";
import {
  LAUNDRY_INCIDENT_CONDITIONS,
  LAUNDRY_PRIORITIES,
  LAUNDRY_SUPPLY_SUGGESTIONS,
  laundryBatchTone,
  nextLaundryStatus,
  str,
  useAdvanceLaundryBatch,
  useLinenItems,
  useMyLaundryBatches,
  useMyLaundryTasks,
  useReportLaundryFault,
  useReportLaundryStockNeed,
  useReportLinenIncident,
  type LaundryRow,
} from "@/lib/laundry-department";

export const Route = createFileRoute("/_shell/laundry/my-work")({
  head: () => ({
    meta: [
      { title: "My Work — Laundry — NEØ" },
      {
        name: "description",
        content:
          "The laundry batches assigned to you, with supply, damage and equipment reporting.",
      },
      { property: "og:title", content: "My Work — Laundry — NEØ" },
      {
        property: "og:description",
        content:
          "Process your assigned laundry batches and report shortages, damage and equipment faults.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="laundry" action="my-work.view">
      <LaundryMyWorkPage />
    </OpsGuard>
  ),
});

function LaundryMyWorkPage() {
  const batches = useMyLaundryBatches();
  const tasks = useMyLaundryTasks();
  const advance = useAdvanceLaundryBatch();

  const [supplyOpen, setSupplyOpen] = useState(false);
  const [damageOpen, setDamageOpen] = useState(false);
  const [faultOpen, setFaultOpen] = useState(false);

  const rows = (batches.data ?? []) as LaundryRow[];
  const taskRows = (tasks.data ?? []) as LaundryRow[];
  const active = rows.filter((r) => !["received"].includes(str(r["status"], ""))).length;

  return (
    <div>
      <PageHeader
        eyebrow="Laundry"
        title="My work"
        description="Only the batches assigned to you. Move each one along as you process it, and report anything you are short of."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setSupplyOpen(true)}>
              <PackagePlus className="mr-2 h-4 w-4" /> Report supply need
            </Button>
            <Button variant="outline" onClick={() => setDamageOpen(true)}>
              <ShieldAlert className="mr-2 h-4 w-4" /> Report damage
            </Button>
            <Button variant="outline" onClick={() => setFaultOpen(true)}>
              <Wrench className="mr-2 h-4 w-4" /> Report equipment fault
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Assigned batches" value={String(rows.length)} hint="open work" />
        <StatCard label="In progress" value={String(active)} hint="started by you" />
        <StatCard label="My tasks" value={String(taskRows.length)} hint="non-batch work" />
      </div>

      <SectionCard title="Assigned batches" description="Your queue, in the order it was received.">
        <QueryState
          isLoading={batches.isLoading}
          error={batches.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No batches assigned to you"
              description="Your Laundry Manager assigns batches; they appear here as soon as they do."
              icon={WashingMachine}
            />
          }
        >
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((row) => {
              const status = str(row["status"], "received");
              const next = nextLaundryStatus(status);
              return (
                <div key={String(row["id"])} className="rounded-xl border border-border/70 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{str(row["batch_number"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {titleCase(str(row["batch_kind"], "linen"))} · received{" "}
                        {shortDateTime(row["received_at"] as string)}
                      </p>
                    </div>
                    <StatusPill tone={laundryBatchTone(status)}>
                      {titleCase(status.replace("-", " "))}
                    </StatusPill>
                  </div>
                  {row["notes"] ? (
                    <p className="mt-2 text-sm text-muted-foreground">{str(row["notes"])}</p>
                  ) : null}
                  {next ? (
                    <Button
                      size="sm"
                      className="mt-3"
                      disabled={advance.isPending}
                      onClick={() => advance.mutate({ batchId: String(row["id"]), status: next })}
                    >
                      Mark {next.replace("-", " ")}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <div className="mt-6">
        <SectionCard title="My tasks" description="Other laundry work assigned to you.">
          <QueryState
            isLoading={tasks.isLoading}
            error={tasks.error}
            isEmpty={taskRows.length === 0}
            empty={
              <EmptyState
                title="No tasks assigned"
                description="Tasks assigned to you appear here."
              />
            }
          >
            <ul className="space-y-2">
              {taskRows.map((task) => (
                <li key={String(task["id"])} className="rounded-lg border border-border/70 p-3">
                  <p className="text-sm font-medium">{str(task["title"], "Task")}</p>
                  <p className="text-xs text-muted-foreground">
                    {titleCase(str(task["status"], "open"))} · due{" "}
                    {shortDateTime(task["due_at"] as string)}
                  </p>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>
      </div>

      <SupplyDialog open={supplyOpen} onClose={() => setSupplyOpen(false)} />
      <DamageDialog open={damageOpen} onClose={() => setDamageOpen(false)} />
      <FaultDialog open={faultOpen} onClose={() => setFaultOpen(false)} />
    </div>
  );
}

function SupplyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const report = useReportLaundryStockNeed();
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report a supply need</DialogTitle>
          <DialogDescription>
            Your manager reviews this and decides whether it becomes a Stores requisition.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Item</Label>
            <Input
              value={item}
              onChange={(e) => setItem(e.target.value)}
              placeholder="e.g. Detergent"
              list="laundry-supply-list"
            />
            <datalist id="laundry-supply-list">
              {LAUNDRY_SUPPLY_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quantity</Label>
              <Input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LAUNDRY_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {titleCase(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!item.trim() || quantity <= 0 || report.isPending}
            onClick={() =>
              report.mutate(
                { item: item.trim(), quantity, priority, notes: notes.trim() },
                {
                  onSuccess: () => {
                    setItem("");
                    setQuantity(1);
                    setNotes("");
                    onClose();
                  },
                },
              )
            }
          >
            Send to manager
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DamageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const linen = useLinenItems();
  const report = useReportLinenIncident();
  const [linenItemId, setLinenItemId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState("damaged");
  const [reason, setReason] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report damaged or lost linen</DialogTitle>
          <DialogDescription>
            The Laundry Manager reviews every report; write-offs go through approval.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Linen item</Label>
            <Select value={linenItemId} onValueChange={setLinenItemId}>
              <SelectTrigger>
                <SelectValue placeholder="Select the item" />
              </SelectTrigger>
              <SelectContent>
                {(linen.data ?? []).map((li) => (
                  <SelectItem key={String(li["id"])} value={String(li["id"])}>
                    {str(li["name"], "Linen")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quantity</Label>
              <Input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Condition</Label>
              <Select value={condition} onValueChange={setCondition}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LAUNDRY_INCIDENT_CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {titleCase(c.replace("-", " "))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>What happened</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!reason.trim() || quantity <= 0 || report.isPending}
            onClick={() =>
              report.mutate(
                { linenItemId: linenItemId || null, quantity, condition, reason: reason.trim() },
                {
                  onSuccess: () => {
                    setReason("");
                    setQuantity(1);
                    setLinenItemId("");
                    onClose();
                  },
                },
              )
            }
          >
            Report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FaultDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const report = useReportLaundryFault();
  const [description, setDescription] = useState("");
  const [machine, setMachine] = useState("");
  const [priority, setPriority] = useState("normal");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report an equipment fault</DialogTitle>
          <DialogDescription>This raises a work order for Maintenance.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Machine</Label>
            <Input
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              placeholder="e.g. Washer 2"
            />
          </div>
          <div>
            <Label>Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAUNDRY_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {titleCase(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Fault</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!description.trim() || report.isPending}
            onClick={() =>
              report.mutate(
                { description: description.trim(), machine: machine.trim() || null, priority },
                {
                  onSuccess: () => {
                    setDescription("");
                    setMachine("");
                    onClose();
                  },
                },
              )
            }
          >
            Report to Maintenance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

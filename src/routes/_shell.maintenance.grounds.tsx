import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
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
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/operations";
import { useAssets, useStaffLite } from "@/lib/operations-data";
import {
  GROUNDS_AREA_SUGGESTIONS,
  GROUNDS_STATUS_LABELS,
  groundsTone,
  maintStr,
  nextGroundsStatus,
  useAdvanceGroundsTask,
  useAssignGroundsTask,
  useCreateGroundsArea,
  useCreateGroundsTask,
  useGroundsAreas,
  useGroundsTasks,
  type MaintRow,
} from "@/lib/maintenance-department";

export const Route = createFileRoute("/_shell/maintenance/grounds")({
  head: () => ({
    meta: [
      { title: "Grounds & Landscaping Board — NEØ" },
      {
        name: "description",
        content:
          "Assign lawns, hedges, walkways and pool-surround work to ground workers and follow each task to completion.",
      },
      { property: "og:title", content: "Grounds & Landscaping Board — NEØ" },
      {
        property: "og:description",
        content:
          "The Maintenance Manager's board for grounds work: create tasks, assign ground workers, watch progress.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="maintenance" action="grounds.view">
      <GroundsBoardPage />
    </OpsGuard>
  ),
});

function GroundsBoardPage() {
  const { can } = useAuth();
  const tasks = useGroundsTasks();
  const staff = useStaffLite("maintenance");
  const assets = useAssets();
  const areas = useGroundsAreas();
  const create = useCreateGroundsTask();
  const createArea = useCreateGroundsArea();
  const assign = useAssignGroundsTask();
  const advance = useAdvanceGroundsTask();
  const mayManage = can("maintenance", "grounds.edit");

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [areaId, setAreaId] = useState("");
  const [newAreaName, setNewAreaName] = useState("");
  const [equipment, setEquipment] = useState("");
  const [due, setDue] = useState("");
  const [instruction, setInstruction] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState("normal");
  const [noteFor, setNoteFor] = useState<{ id: string; status: string } | null>(null);
  const [note, setNote] = useState("");

  const rows = (tasks.data ?? []) as MaintRow[];
  const people = (staff.data ?? []) as MaintRow[];
  const areaRows = useMemo(
    () => (areas.data ?? []).filter((a) => a["active"] !== false),
    [areas.data],
  );
  // Grounds equipment is the canonical asset register, not a second list of
  // mowers. Anything the hotel registered as equipment can be named on a job.
  const equipmentOptions = useMemo(
    () =>
      (assets.data ?? [])
        .filter((a) => String(a["status"] ?? "") !== "disposed")
        .map((a) => ({ id: String(a["id"]), name: maintStr(a["name"], "Unnamed asset") })),
    [assets.data],
  );
  const assetNameById = useMemo(
    () => new Map(equipmentOptions.map((a) => [a.id, a.name])),
    [equipmentOptions],
  );
  const openCount = rows.filter((r) => !["completed"].includes(String(r["status"]))).length;
  const blocked = rows.filter((r) => String(r["status"]) === "blocked").length;

  const nameOf = (id: unknown) =>
    maintStr(people.find((p) => String(p["id"]) === String(id ?? ""))?.["full_name"], "Unassigned");

  const submit = () => {
    const chosen = areaRows.find((a) => String(a["id"]) === areaId);
    create.mutate(
      {
        title,
        area: chosen ? maintStr(chosen["name"], "") : newAreaName.trim(),
        areaId: areaId || null,
        equipmentAssetId: equipment || null,
        dueAt: due ? new Date(`${due}T17:00:00`).toISOString() : null,
        instruction,
        assigneeId: assignee || null,
        priority,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setTitle("");
          setInstruction("");
          setDue("");
          setEquipment("");
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Maintenance Department"
        title="Grounds board"
        description="Physical grounds and landscaping work across the property, and who is carrying it out."
        actions={
          mayManage ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" asChild>
                <Link to="/admin/grounds-areas">Areas</Link>
              </Button>
              <Button onClick={() => setOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> New grounds task
              </Button>
            </div>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="Outstanding">
          <p className="text-3xl font-semibold">{openCount}</p>
        </SectionCard>
        <SectionCard title="Blocked">
          <p className="text-3xl font-semibold">{blocked}</p>
        </SectionCard>
        <SectionCard title="Recorded (last 300)">
          <p className="text-3xl font-semibold">{rows.length}</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Grounds tasks"
        description="Lawns, hedges, walkways, car park, pool surrounds and garden beds — with the equipment used and the full trail of each job."
      >
        <QueryState
          isLoading={tasks.isLoading}
          error={tasks.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No grounds work recorded"
              description="Create a task here, or let the landscaping schedule raise the recurring work automatically."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Area</TableHead>
                  <TableHead>Equipment</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Progress</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const status = String(r["status"] ?? "");
                  const next = nextGroundsStatus(status);
                  return (
                    <TableRow key={String(r["id"])}>
                      <TableCell className="font-medium">
                        {maintStr(r["title"])}
                        {r["schedule_id"] ? (
                          <div className="text-xs font-normal text-muted-foreground">
                            From the landscaping programme
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{maintStr(r["area_label"])}</TableCell>
                      <TableCell>
                        {r["equipment_asset_id"]
                          ? (assetNameById.get(String(r["equipment_asset_id"])) ??
                            "Registered asset")
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {mayManage ? (
                          <Select
                            value={String(r["assignee_user_id"] ?? "")}
                            onValueChange={(v) =>
                              assign.mutate({ taskId: String(r["id"]), assigneeId: v })
                            }
                          >
                            <SelectTrigger className="h-8 w-48">
                              <SelectValue placeholder="Unassigned" />
                            </SelectTrigger>
                            <SelectContent>
                              {people.map((p) => (
                                <SelectItem key={String(p["id"])} value={String(p["id"])}>
                                  {maintStr(p["full_name"])}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          nameOf(r["assignee_user_id"])
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r["due_at"] ? maintStr(r["due_at"]) : "Not set"}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={groundsTone(status)}>
                          {GROUNDS_STATUS_LABELS[status] ?? titleCase(maintStr(r["status"]))}
                        </StatusPill>
                        {status === "blocked" && maintStr(r["blocker"], "") !== "—" ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {maintStr(r["blocker"])}
                          </p>
                        ) : null}
                        {maintStr(r["completion_notes"], "") !== "—" ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {maintStr(r["completion_notes"])}
                          </p>
                        ) : null}
                      </TableCell>
                      {/* The manager can move a job forward from the board — a
                          ground worker without a phone to hand should not stop
                          the record reflecting what actually happened. */}
                      <TableCell className="text-right">
                        {mayManage && next ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={advance.isPending}
                              onClick={() =>
                                next === "completed" || next === "ready"
                                  ? setNoteFor({ id: String(r["id"]), status: next })
                                  : advance.mutate({ taskId: String(r["id"]), status: next })
                              }
                            >
                              Mark {GROUNDS_STATUS_LABELS[next]?.toLowerCase() ?? next}
                            </Button>
                            {status !== "blocked" && status !== "completed" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={advance.isPending}
                                onClick={() =>
                                  setNoteFor({ id: String(r["id"]), status: "blocked" })
                                }
                              >
                                Blocked
                              </Button>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New grounds task</DialogTitle>
            <DialogDescription>
              Physical grounds work carried out by a ground worker.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="title">Task</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Mow the main lawn"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Area</Label>
                {areaRows.length > 0 ? (
                  <Select value={areaId} onValueChange={setAreaId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose an area" />
                    </SelectTrigger>
                    <SelectContent>
                      {areaRows.map((a) => (
                        <SelectItem key={String(a["id"])} value={String(a["id"])}>
                          {maintStr(a["name"])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  // With nothing configured yet the hotel names its first area
                  // here; it becomes a real record it can rename or retire.
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Input
                        value={newAreaName}
                        onChange={(e) => setNewAreaName(e.target.value)}
                        placeholder={GROUNDS_AREA_SUGGESTIONS[0]}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!newAreaName.trim() || createArea.isPending}
                        onClick={() =>
                          createArea.mutate(
                            { name: newAreaName },
                            {
                              onSuccess: (row) => {
                                setAreaId(String(row["id"]));
                                setNewAreaName("");
                              },
                            },
                          )
                        }
                      >
                        Add
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      No areas configured yet. Add one here or in{" "}
                      <Link to="/admin/grounds-areas" className="text-primary hover:underline">
                        Grounds Areas
                      </Link>
                      .
                    </p>
                  </div>
                )}
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["low", "normal", "high", "urgent"].map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Ground worker</Label>
                <Select value={assignee} onValueChange={setAssignee}>
                  <SelectTrigger>
                    <SelectValue placeholder="Assign later" />
                  </SelectTrigger>
                  <SelectContent>
                    {people.map((p) => (
                      <SelectItem key={String(p["id"])} value={String(p["id"])}>
                        {maintStr(p["full_name"])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Due date</Label>
                <NeoDatePicker value={due} onChange={setDue} />
              </div>
            </div>
            <div>
              <Label>Equipment (optional)</Label>
              <Select value={equipment} onValueChange={setEquipment}>
                <SelectTrigger>
                  <SelectValue placeholder="No equipment needed" />
                </SelectTrigger>
                <SelectContent>
                  {equipmentOptions.length === 0 ? (
                    <div className="px-2 py-3 text-sm text-muted-foreground">
                      No equipment registered for this property yet.
                    </div>
                  ) : (
                    equipmentOptions.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="instruction">Instructions</Label>
              <Textarea
                id="instruction"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={create.isPending || !title.trim()} onClick={submit}>
              Create task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(noteFor)} onOpenChange={(v) => !v && setNoteFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {noteFor?.status === "blocked" ? "What is blocking this?" : "What was done?"}
            </DialogTitle>
            <DialogDescription>
              This note stays on the task record as part of its history.
            </DialogDescription>
          </DialogHeader>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={!note.trim() || advance.isPending}
              onClick={() =>
                noteFor &&
                advance.mutate(
                  {
                    taskId: noteFor.id,
                    status: noteFor.status as "completed" | "ready" | "blocked",
                    note,
                  },
                  {
                    onSuccess: () => {
                      setNoteFor(null);
                      setNote("");
                    },
                  },
                )
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

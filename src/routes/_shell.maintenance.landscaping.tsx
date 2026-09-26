import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarClock, Plus } from "lucide-react";
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
import { useAssets, useStaffLite } from "@/lib/operations-data";
import {
  GROUNDS_AREA_SUGGESTIONS,
  LANDSCAPING_FREQUENCIES,
  maintStr,
  useCreateGroundsArea,
  useGenerateLandscapingWork,
  useGroundsAreas,
  useLandscapingSchedules,
  useSaveLandscapingSchedule,
  type MaintRow,
} from "@/lib/maintenance-department";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/maintenance/landscaping")({
  head: () => ({
    meta: [
      { title: "Landscaping Programme — NEØ" },
      {
        name: "description",
        content:
          "Recurring grounds work — lawns, hedges, walkways and pool surrounds — with due dates and assigned ground workers.",
      },
      { property: "og:title", content: "Landscaping Programme — NEØ" },
      {
        property: "og:description",
        content: "Plan recurring landscaping work and raise the day's grounds tasks in one action.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="maintenance" action="landscaping.view">
      <LandscapingPage />
    </OpsGuard>
  ),
});

function LandscapingPage() {
  const { can } = useAuth();
  const schedules = useLandscapingSchedules();
  const staff = useStaffLite("maintenance");
  const save = useSaveLandscapingSchedule();
  const generate = useGenerateLandscapingWork();
  const areas = useGroundsAreas();
  const createArea = useCreateGroundsArea();
  const assets = useAssets();
  const mayManage = can("maintenance", "landscaping.edit");

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [areaId, setAreaId] = useState("");
  const [newAreaName, setNewAreaName] = useState("");
  const [equipment, setEquipment] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [nextDue, setNextDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [instructions, setInstructions] = useState("");

  const rows = (schedules.data ?? []) as MaintRow[];
  const people = (staff.data ?? []) as MaintRow[];
  const areaRows = (areas.data ?? []).filter((a) => a["active"] !== false);
  // Equipment comes from the canonical asset register, so a mower on a
  // schedule is the same mower the maintenance and asset records know about.
  const equipmentOptions = (assets.data ?? [])
    .filter((a) => String(a["status"] ?? "") !== "disposed")
    .map((a) => ({ id: String(a["id"]), name: maintStr(a["name"], "Unnamed asset") }));
  const today = new Date().toISOString().slice(0, 10);
  const dueNow = rows.filter(
    (r) => Boolean(r["active"]) && String(r["next_due_date"] ?? "") <= today,
  ).length;

  const submit = () => {
    const freq = LANDSCAPING_FREQUENCIES.find((f) => f.value === frequency);
    save.mutate(
      {
        name,
        area: areaRows.find((a) => String(a["id"]) === areaId)
          ? maintStr(areaRows.find((a) => String(a["id"]) === areaId)?.["name"], "")
          : newAreaName.trim(),
        areaId: areaId || null,
        equipmentAssetId: equipment || null,
        frequency,
        intervalDays: freq?.days ?? 7,
        nextDue: nextDue || null,
        instructions,
        assigneeId: assignee || null,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setName("");
          setInstructions("");
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Maintenance Department"
        title="Landscaping programme"
        description="Recurring grounds work planned once, then raised as tasks for the ground workers on the day it falls due."
        actions={
          mayManage ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={generate.isPending}
                onClick={() => generate.mutate()}
              >
                <CalendarClock className="mr-2 h-4 w-4" /> Raise work due today
              </Button>
              <Button onClick={() => setOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> New schedule
              </Button>
            </div>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="Active schedules">
          <p className="text-3xl font-semibold">
            {rows.filter((r) => Boolean(r["active"])).length}
          </p>
        </SectionCard>
        <SectionCard title="Due today or overdue">
          <p className="text-3xl font-semibold">{dueNow}</p>
        </SectionCard>
        <SectionCard title="Total planned">
          <p className="text-3xl font-semibold">{rows.length}</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Schedules"
        description="Each schedule raises one grounds task per due date — never a duplicate."
      >
        <QueryState
          isLoading={schedules.isLoading}
          error={schedules.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No landscaping schedules"
              description="Plan the recurring grounds work — mowing, hedge trimming, walkway sweeping — and it will raise itself."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Area</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={String(r["id"])}>
                    <TableCell className="font-medium">{maintStr(r["name"])}</TableCell>
                    <TableCell>{maintStr(r["area_label"])}</TableCell>
                    <TableCell>
                      {LANDSCAPING_FREQUENCIES.find((f) => f.value === String(r["frequency"]))
                        ?.label ?? maintStr(r["frequency"])}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {maintStr(r["next_due_date"])}
                    </TableCell>
                    <TableCell>
                      {maintStr(
                        people.find(
                          (p) => String(p["id"]) === String(r["assignee_user_id"] ?? ""),
                        )?.["full_name"],
                        "Unassigned",
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={r["active"] ? "success" : "default"}>
                        {r["active"] ? "Active" : "Paused"}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New landscaping schedule</DialogTitle>
            <DialogDescription>Recurring grounds work with a fixed rhythm.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="schedule-name">Name</Label>
              <Input
                id="schedule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Mow main lawn"
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
                      No areas configured yet — add one here or in{" "}
                      <Link to="/admin/grounds-areas" className="text-primary hover:underline">
                        Grounds Areas
                      </Link>
                      .
                    </p>
                  </div>
                )}
              </div>
              <div>
                <Label>Frequency</Label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANDSCAPING_FREQUENCIES.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="next-due">First / next due date</Label>
                <NeoDatePicker id="next-due" value={nextDue} onChange={setNextDue} />
              </div>
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
              <Label htmlFor="instructions">Instructions</Label>
              <Textarea
                id="instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={save.isPending || !name.trim()} onClick={submit}>
              Save schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

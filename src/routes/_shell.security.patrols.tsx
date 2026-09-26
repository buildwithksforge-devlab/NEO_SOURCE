import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  EmptyState,
  QueryState,
  SecurityGuard,
  SecurityStatusBadge,
  WhenLabel,
} from "@/components/security/SecurityShared";
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
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/kitchen";
import {
  patrolCheckpoints,
  patrolProgress,
  securityStr,
  useAssignPatrol,
  useCreatePatrol,
  useSecurityPatrols,
  useSecurityStaff,
  type SecurityRow,
} from "@/lib/security-department";

export const Route = createFileRoute("/_shell/security/patrols")({
  head: () => ({
    meta: [
      { title: "Security Patrols — NEØ" },
      {
        name: "description",
        content:
          "Schedule patrol rounds with named checkpoints, assign them to guards and see exactly which points were walked and when.",
      },
      { property: "og:title", content: "Security Patrols — NEØ" },
      {
        property: "og:description",
        content: "Patrol rounds, checkpoints and completion evidence for the Security department.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <SecurityGuard feature="patrols">
      <PatrolsPage />
    </SecurityGuard>
  ),
});

function PatrolsPage() {
  const { can } = useAuth();
  const mayManage = can("security-ops", "patrols", "create");
  const [status, setStatus] = useState("all");
  const patrols = useSecurityPatrols(status);
  const staff = useSecurityStaff();
  const create = useCreatePatrol();
  const assign = useAssignPatrol();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [assignee, setAssignee] = useState("none");
  const [areas, setAreas] = useState("");
  const [notes, setNotes] = useState("");

  const rows = (patrols.data ?? []) as SecurityRow[];
  const staffRows = (staff.data ?? []) as SecurityRow[];

  function submit() {
    const checkpoints = areas
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean)
      .map((area) => ({ area }));
    if (!title.trim() || checkpoints.length === 0) return;
    create.mutate(
      {
        title,
        checkpoints,
        scheduledFor: scheduled ? new Date(scheduled).toISOString() : null,
        assigneeId: assignee === "none" ? null : assignee,
        ...(notes ? { notes } : {}),
      },
      {
        onSuccess: () => {
          setOpen(false);
          setTitle("");
          setAreas("");
          setNotes("");
          setScheduled("");
          setAssignee("none");
        },
      },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="Patrols"
        description="A round is only complete when every checkpoint has been recorded. Schedule the rounds, assign a guard and the evidence builds itself."
        actions={
          mayManage ? <Button onClick={() => setOpen(true)}>Schedule patrol</Button> : undefined
        }
      />

      <SectionCard
        title="Patrol schedule"
        description="Rounds for this property, newest first."
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["all", "scheduled", "in-progress", "completed", "cancelled"].map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <QueryState
          isLoading={patrols.isLoading}
          error={patrols.error}
          isEmpty={rows.length === 0}
          empty={<EmptyState title="No patrols" description="No rounds match this filter." />}
        >
          <div className="space-y-3">
            {rows.map((r) => {
              const progress = patrolProgress(r["checkpoints"]);
              const points = patrolCheckpoints(r["checkpoints"]);
              return (
                <div key={String(r["id"])} className="rounded-lg border border-border/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{securityStr(r["title"])}</p>
                      <WhenLabel value={securityStr(r["scheduled_for"], "")} prefix="Scheduled" />
                      <p className="text-xs text-muted-foreground">
                        {progress.done} of {progress.total} checkpoints walked
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <SecurityStatusBadge status={String(r["status"])} />
                      {mayManage ? (
                        <Select
                          value={securityStr(r["assignee_id"], "none")}
                          onValueChange={(v) =>
                            v !== "none" && assign.mutate({ patrolId: String(r["id"]), guardId: v })
                          }
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder="Assign a guard" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Unassigned</SelectItem>
                            {staffRows.map((s) => (
                              <SelectItem key={String(s["id"])} value={String(s["id"])}>
                                {securityStr(s["full_name"])}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {points.map((p, i) => (
                      <span
                        key={`${String(r["id"])}-${i}`}
                        className={
                          p.done_at
                            ? "rounded-md bg-primary/10 px-2 py-1 text-xs text-primary"
                            : "rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                        }
                      >
                        {p.area}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Schedule a patrol</DialogTitle>
            <DialogDescription>
              List each checkpoint on its own line, in walking order.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="patrol-title">Round name</Label>
              <Input
                id="patrol-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Night perimeter round"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="patrol-when">Scheduled for</Label>
              <Input
                id="patrol-when"
                type="datetime-local"
                value={scheduled}
                onChange={(e) => setScheduled(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Guard</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Assign later</SelectItem>
                  {staffRows.map((s) => (
                    <SelectItem key={String(s["id"])} value={String(s["id"])}>
                      {securityStr(s["full_name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="patrol-areas">Checkpoints</Label>
              <Textarea
                id="patrol-areas"
                value={areas}
                onChange={(e) => setAreas(e.target.value)}
                rows={5}
                placeholder={"Main gate\nRear car park\nStaff entrance\nPool deck"}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="patrol-notes">Notes</Label>
              <Textarea
                id="patrol-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={create.isPending || !title.trim() || !areas.trim()}>
              Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

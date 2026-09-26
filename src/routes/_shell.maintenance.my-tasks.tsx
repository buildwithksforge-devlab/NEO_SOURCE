import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { titleCase } from "@/lib/operations";
import {
  GROUNDS_STATUS_LABELS,
  groundsTone,
  maintStr,
  nextGroundsStatus,
  useAdvanceGroundsTask,
  useMyGroundsTasks,
  type MaintRow,
} from "@/lib/maintenance-department";

export const Route = createFileRoute("/_shell/maintenance/my-tasks")({
  head: () => ({
    meta: [
      { title: "My Grounds Tasks — NEØ" },
      {
        name: "description",
        content:
          "A ground worker's own list of grounds and landscaping tasks, moved forward one stage at a time.",
      },
      { property: "og:title", content: "My Grounds Tasks — NEØ" },
      {
        property: "og:description",
        content: "Start, finish and report blockers on the grounds work assigned to you.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="maintenance" action="my-tasks.view">
      <MyGroundsTasksPage />
    </OpsGuard>
  ),
});

function MyGroundsTasksPage() {
  const tasks = useMyGroundsTasks();
  const advance = useAdvanceGroundsTask();
  const [blockFor, setBlockFor] = useState<MaintRow | null>(null);
  const [reason, setReason] = useState("");

  const rows = (tasks.data ?? []) as MaintRow[];
  const todo = rows.filter((r) => String(r["status"]) !== "completed");

  return (
    <div>
      <PageHeader
        eyebrow="Maintenance Department"
        title="My grounds tasks"
        description="Only the work assigned to you. Progress moves forward one stage at a time — if something stops you, report it."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="To do">
          <p className="text-3xl font-semibold">{todo.length}</p>
        </SectionCard>
        <SectionCard title="In progress">
          <p className="text-3xl font-semibold">
            {rows.filter((r) => String(r["status"]) === "in-progress").length}
          </p>
        </SectionCard>
        <SectionCard title="Completed">
          <p className="text-3xl font-semibold">
            {rows.filter((r) => String(r["status"]) === "completed").length}
          </p>
        </SectionCard>
      </div>

      <SectionCard
        title="Assigned to me"
        description="Lawns, hedges, walkways and any other grounds work given to you."
      >
        <QueryState
          isLoading={tasks.isLoading}
          error={tasks.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="Nothing assigned to you"
              description="When your supervisor assigns grounds work, or a landscaping schedule falls due, it appears here."
            />
          }
        >
          <div className="space-y-3">
            {rows.map((r) => {
              const status = String(r["status"] ?? "not-started");
              const next = nextGroundsStatus(status);
              return (
                <div
                  key={String(r["id"])}
                  className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium">{maintStr(r["title"])}</p>
                    <p className="text-sm text-muted-foreground">
                      {maintStr(r["area_label"])} · {maintStr(r["service_date"])} ·{" "}
                      {titleCase(maintStr(r["priority"], "normal"))}
                    </p>
                    {maintStr(r["instruction"], "") !== "—" ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {maintStr(r["instruction"])}
                      </p>
                    ) : null}
                    {status === "blocked" ? (
                      <p className="mt-1 text-sm text-destructive">
                        Blocked: {maintStr(r["blocker"])}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={groundsTone(status)}>
                      {GROUNDS_STATUS_LABELS[status] ?? status}
                    </StatusPill>
                    {next && status !== "completed" ? (
                      <Button
                        size="sm"
                        disabled={advance.isPending}
                        onClick={() => advance.mutate({ taskId: String(r["id"]), status: next })}
                      >
                        {GROUNDS_STATUS_LABELS[next]}
                      </Button>
                    ) : null}
                    {status !== "completed" && status !== "blocked" ? (
                      <Button size="sm" variant="outline" onClick={() => setBlockFor(r)}>
                        Report blocker
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={blockFor !== null} onOpenChange={(o) => !o && setBlockFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a blocker</DialogTitle>
            <DialogDescription>
              Your supervisor sees this immediately. Use it when a tool, material or access is
              missing.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="reason">What is stopping you</Label>
            <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={advance.isPending || !reason.trim() || !blockFor}
              onClick={() =>
                blockFor &&
                advance.mutate(
                  { taskId: String(blockFor["id"]), status: "blocked", note: reason },
                  {
                    onSuccess: () => {
                      setBlockFor(null);
                      setReason("");
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
    </div>
  );
}

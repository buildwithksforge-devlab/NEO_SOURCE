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
import { titleCase } from "@/lib/kitchen";
import {
  patrolCheckpoints,
  securityStr,
  useAdvanceSecurityTask,
  useCompletePatrol,
  useMySecurityWork,
  useRecordCheckpoint,
  type SecurityRow,
} from "@/lib/security-department";

export const Route = createFileRoute("/_shell/security/my-post")({
  head: () => ({
    meta: [
      { title: "My Post — NEØ Security" },
      {
        name: "description",
        content:
          "A guard's own workspace: the post on duty this shift, the patrols to walk, checkpoints to record and the security tasks assigned to them.",
      },
      { property: "og:title", content: "My Post — NEØ Security" },
      {
        property: "og:description",
        content: "Your post, your patrols and your tasks for this shift.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <SecurityGuard feature="my-post">
      <MyPostPage />
    </SecurityGuard>
  ),
});

function MyPostPage() {
  const work = useMySecurityWork();
  const checkpoint = useRecordCheckpoint();
  const complete = useCompletePatrol();
  const advance = useAdvanceSecurityTask();

  const rows = (work.data ?? []) as SecurityRow[];
  const posts = rows.filter((r) => r["source"] === "post");
  const patrols = rows.filter((r) => r["source"] === "patrol");
  const tasks = rows.filter((r) => r["source"] === "task");

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="My post"
        description="Everything you are responsible for this shift and nothing else. Record each checkpoint as you walk it so the round is provable."
      />

      <QueryState
        isLoading={work.isLoading}
        error={work.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="Nothing assigned"
            description="You have no post, patrol or task assigned at the moment. Your Security Supervisor assigns these."
          />
        }
      >
        <div className="space-y-6">
          <SectionCard title="Post on duty" description="Where you are stationed for this shift.">
            {posts.length === 0 ? (
              <EmptyState
                title="No post assigned"
                description="You are not stationed at a post right now."
              />
            ) : (
              <div className="space-y-2">
                {posts.map((r) => (
                  <div
                    key={String(r["id"])}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{securityStr(r["title"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {securityStr(r["reference"], "Area not recorded")} ·{" "}
                        {titleCase(securityStr(r["detail"], "day"))} shift
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <WhenLabel value={securityStr(r["due_at"], "")} prefix="Until" />
                      <SecurityStatusBadge status={String(r["status"])} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="My patrols"
            description="Tick every checkpoint as you reach it, then close the round."
          >
            {patrols.length === 0 ? (
              <EmptyState title="No patrols" description="No rounds are assigned to you." />
            ) : (
              <div className="space-y-3">
                {patrols.map((r) => {
                  const points = patrolCheckpoints(r["checkpoints"]);
                  const remaining = points.filter((p) => !p.done_at).length;
                  return (
                    <div key={String(r["id"])} className="rounded-lg border border-border/70 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{securityStr(r["title"])}</p>
                          <WhenLabel value={securityStr(r["due_at"], "")} prefix="Scheduled" />
                        </div>
                        <div className="flex items-center gap-2">
                          <SecurityStatusBadge status={String(r["status"])} />
                          <Button
                            size="sm"
                            disabled={complete.isPending || remaining > 0}
                            onClick={() => complete.mutate({ patrolId: String(r["id"]) })}
                          >
                            Complete round
                          </Button>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {points.map((p, i) => (
                          <div
                            key={`${String(r["id"])}-${i}`}
                            className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
                          >
                            <div>
                              <p className="text-sm">{p.area}</p>
                              {p.done_at ? (
                                <p className="text-xs text-muted-foreground">
                                  Walked {new Date(p.done_at).toLocaleTimeString()}
                                </p>
                              ) : (
                                <p className="text-xs text-muted-foreground">Not yet walked</p>
                              )}
                            </div>
                            <Button
                              size="sm"
                              variant={p.done_at ? "ghost" : "outline"}
                              disabled={Boolean(p.done_at) || checkpoint.isPending}
                              onClick={() =>
                                checkpoint.mutate({ patrolId: String(r["id"]), index: i })
                              }
                            >
                              {p.done_at ? "Done" : "Record"}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="My tasks"
            description="Security duties assigned to you by the Supervisor."
          >
            {tasks.length === 0 ? (
              <EmptyState title="No tasks" description="Nothing else is outstanding for you." />
            ) : (
              <div className="space-y-2">
                {tasks.map((r) => {
                  const status = String(r["status"]);
                  const next = status === "pending" ? "in-progress" : "completed";
                  return (
                    <div
                      key={String(r["id"])}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{securityStr(r["title"])}</p>
                        <p className="text-xs text-muted-foreground">
                          {securityStr(r["detail"], "")}
                        </p>
                        <WhenLabel value={securityStr(r["due_at"], "")} />
                      </div>
                      <div className="flex items-center gap-2">
                        <SecurityStatusBadge status={status} />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={advance.isPending}
                          onClick={() => advance.mutate({ taskId: String(r["id"]), status: next })}
                        >
                          {next === "in-progress" ? "Start" : "Mark complete"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </div>
      </QueryState>
    </div>
  );
}

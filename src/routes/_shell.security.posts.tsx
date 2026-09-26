import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import {
  EmptyState,
  QueryState,
  SecurityGuard,
  SecurityStatusBadge,
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
import { titleCase } from "@/lib/kitchen";
import {
  SHIFT_LABELS,
  securityStr,
  useAssignGuardToPost,
  useSecurityAssignments,
  useSecurityPosts,
  useSecurityStaff,
  useUpsertSecurityPost,
  type SecurityRow,
} from "@/lib/security-department";

export const Route = createFileRoute("/_shell/security/posts")({
  head: () => ({
    meta: [
      { title: "Security Posts & Guards — NEØ" },
      {
        name: "description",
        content:
          "Define the guarded posts on the property and roster a guard to each post and shift so coverage is never left to memory.",
      },
      { property: "og:title", content: "Security Posts & Guards — NEØ" },
      {
        property: "og:description",
        content: "Post definitions and the guard roster for each shift.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <SecurityGuard feature="posts">
      <SecurityPostsPage />
    </SecurityGuard>
  ),
});

const today = () => new Date().toISOString().slice(0, 10);

function SecurityPostsPage() {
  const posts = useSecurityPosts();
  const staff = useSecurityStaff();
  const upsert = useUpsertSecurityPost();
  const assign = useAssignGuardToPost();

  const [shiftDate, setShiftDate] = useState(today());
  const assignments = useSecurityAssignments(shiftDate);

  const [postOpen, setPostOpen] = useState(false);
  const [name, setName] = useState("");
  const [area, setArea] = useState("");
  const [notes, setNotes] = useState("");

  const [assignFor, setAssignFor] = useState<SecurityRow | null>(null);
  const [guardId, setGuardId] = useState("");
  const [shiftLabel, setShiftLabel] = useState<string>("day");
  const [assignNotes, setAssignNotes] = useState("");

  const postRows = (posts.data ?? []) as SecurityRow[];
  const staffRows = (staff.data ?? []) as SecurityRow[];
  const assignmentRows = (assignments.data ?? []) as SecurityRow[];

  function savePost() {
    if (!name.trim()) return;
    upsert.mutate(
      { name, ...(area ? { area } : {}), ...(notes ? { notes } : {}) },
      {
        onSuccess: () => {
          setPostOpen(false);
          setName("");
          setArea("");
          setNotes("");
        },
      },
    );
  }

  function saveAssignment() {
    if (!assignFor || !guardId) return;
    assign.mutate(
      {
        postId: String(assignFor["id"]),
        guardId,
        shiftDate,
        shiftLabel,
        ...(assignNotes ? { notes: assignNotes } : {}),
      },
      {
        onSuccess: () => {
          setAssignFor(null);
          setGuardId("");
          setAssignNotes("");
        },
      },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="Posts and guard roster"
        description="A post is a place that must always be covered. Define each one, then roster a guard to it for every shift."
        actions={<Button onClick={() => setPostOpen(true)}>Add post</Button>}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Security posts" description="Every guarded position on this property.">
          <QueryState
            isLoading={posts.isLoading}
            error={posts.error}
            isEmpty={postRows.length === 0}
            empty={
              <EmptyState title="No posts defined" description="Add the first guarded position." />
            }
          >
            <div className="space-y-2">
              {postRows.map((p) => (
                <div
                  key={String(p["id"])}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{securityStr(p["name"])}</p>
                    <p className="text-xs text-muted-foreground">
                      {securityStr(p["area"], "Area not recorded")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAssignFor(p);
                      setGuardId("");
                    }}
                  >
                    Assign guard
                  </Button>
                </div>
              ))}
            </div>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Roster"
          description="Who is covering which post."
          actions={
            <NeoDatePicker
              className="w-40"
              value={shiftDate}
              quick={["today", "this-week", "this-month"]}
              onChange={setShiftDate}
            />
          }
        >
          <QueryState
            isLoading={assignments.isLoading}
            error={assignments.error}
            isEmpty={assignmentRows.length === 0}
            empty={
              <EmptyState
                title="Nobody rostered"
                description="No guard is assigned for this date."
              />
            }
          >
            <div className="space-y-2">
              {assignmentRows.map((a) => {
                const post = (a["security_posts"] ?? {}) as Record<string, unknown>;
                const guard = staffRows.find((s) => String(s["id"]) === String(a["guard_id"]));
                return (
                  <div
                    key={String(a["id"])}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{securityStr(post["name"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {guard ? securityStr(guard["full_name"]) : "Guard not on this property"} ·{" "}
                        {titleCase(securityStr(a["shift_label"], "day"))} shift
                      </p>
                    </div>
                    <SecurityStatusBadge status={String(a["status"])} />
                  </div>
                );
              })}
            </div>
          </QueryState>
        </SectionCard>
      </div>

      <Dialog open={postOpen} onOpenChange={setPostOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a security post</DialogTitle>
            <DialogDescription>Name the position and the area it covers.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="post-name">Post name</Label>
              <Input
                id="post-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Main gate"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="post-area">Area covered</Label>
              <Input id="post-area" value={area} onChange={(e) => setArea(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="post-notes">Standing instructions</Label>
              <Textarea
                id="post-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPostOpen(false)}>
              Cancel
            </Button>
            <Button onClick={savePost} disabled={upsert.isPending || !name.trim()}>
              Save post
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(assignFor)} onOpenChange={(o) => !o && setAssignFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign a guard to {securityStr(assignFor?.["name"])}</DialogTitle>
            <DialogDescription>The guard sees this post in their own workspace.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>Guard</Label>
              <Select value={guardId} onValueChange={setGuardId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a guard" />
                </SelectTrigger>
                <SelectContent>
                  {staffRows.map((s) => (
                    <SelectItem key={String(s["id"])} value={String(s["id"])}>
                      {securityStr(s["full_name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Shift</Label>
              <Select value={shiftLabel} onValueChange={setShiftLabel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHIFT_LABELS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="assign-date">Date</Label>
              <NeoDatePicker id="assign-date" value={shiftDate} onChange={setShiftDate} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="assign-notes">Notes</Label>
              <Textarea
                id="assign-notes"
                value={assignNotes}
                onChange={(e) => setAssignNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignFor(null)}>
              Cancel
            </Button>
            <Button onClick={saveAssignment} disabled={assign.isPending || !guardId}>
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

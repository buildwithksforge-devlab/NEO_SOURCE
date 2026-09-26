import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  EmptyState,
  QueryState,
  SecurityGuard,
  SecurityStatusBadge,
  SeverityBadge,
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
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  nextIncidentStatuses,
  securityStr,
  useReportIncident,
  useReviewIncident,
  useSecurityIncidents,
  useSecurityPosts,
  type SecurityRow,
} from "@/lib/security-department";

export const Route = createFileRoute("/_shell/security/incidents")({
  head: () => ({
    meta: [
      { title: "Security Incidents — NEØ" },
      {
        name: "description",
        content:
          "File a security incident report and follow it from reported through investigation and escalation to a closed record that can never be deleted.",
      },
      { property: "og:title", content: "Security Incidents — NEØ" },
      {
        property: "og:description",
        content: "Every security incident, who reported it, what was done and how it was closed.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <SecurityGuard feature="incidents">
      <SecurityIncidentsPage />
    </SecurityGuard>
  ),
});

function SecurityIncidentsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("all");
  const incidents = useSecurityIncidents(status);
  const posts = useSecurityPosts();
  const report = useReportIncident();
  const review = useReviewIncident();

  // Reviewing, escalating and closing is Security Supervisor authority.
  const mayReview = can("security-ops", "incidents", "edit");

  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>(INCIDENT_CATEGORIES[0]);
  const [severity, setSeverity] = useState<string>("low");
  const [location, setLocation] = useState("");
  const [postId, setPostId] = useState("none");
  const [description, setDescription] = useState("");
  const [people, setPeople] = useState("");
  const [witnesses, setWitnesses] = useState("");
  const [action, setAction] = useState("");

  const [reviewing, setReviewing] = useState<SecurityRow | null>(null);
  const [reviewStatus, setReviewStatus] = useState("");
  const [reviewAction, setReviewAction] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");

  const rows = (incidents.data ?? []) as SecurityRow[];

  function submit() {
    if (!description.trim()) return;
    report.mutate(
      {
        category,
        severity,
        description,
        postId: postId === "none" ? null : postId,
        ...(location ? { location } : {}),
        ...(people ? { people } : {}),
        ...(witnesses ? { witnesses } : {}),
        ...(action ? { action } : {}),
      },
      {
        onSuccess: () => {
          setOpen(false);
          setDescription("");
          setLocation("");
          setPeople("");
          setWitnesses("");
          setAction("");
          setSeverity("low");
          setPostId("none");
        },
      },
    );
  }

  function submitReview() {
    if (!reviewing || !reviewStatus) return;
    review.mutate(
      {
        incidentId: String(reviewing["id"]),
        status: reviewStatus,
        ...(reviewAction ? { action: reviewAction } : {}),
        ...(reviewNotes ? { escalationNotes: reviewNotes } : {}),
      },
      {
        onSuccess: () => {
          setReviewing(null);
          setReviewStatus("");
          setReviewAction("");
          setReviewNotes("");
        },
      },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="Incident reports"
        description="Any guard can raise an incident. The Security Supervisor investigates, escalates serious matters to the Operations Manager and closes the record. Nothing here can be deleted."
        actions={<Button onClick={() => setOpen(true)}>Report an incident</Button>}
      />

      <SectionCard
        title="Incident register"
        description={
          mayReview
            ? "The full register for this property."
            : "The incidents you reported and how they were actioned."
        }
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["all", "reported", "under-review", "escalated", "resolved", "closed"].map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <QueryState
          isLoading={incidents.isLoading}
          error={incidents.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No incidents"
              description="Nothing has been reported for this filter."
            />
          }
        >
          <div className="space-y-3">
            {rows.map((r) => {
              const next = nextIncidentStatuses(String(r["status"]));
              return (
                <div key={String(r["id"])} className="rounded-lg border border-border/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">
                        {securityStr(r["incident_number"])} ·{" "}
                        {titleCase(securityStr(r["category"], "other"))}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {securityStr(r["location"], "Location not recorded")} ·{" "}
                        {new Date(String(r["occurred_at"])).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <SeverityBadge severity={securityStr(r["severity"], "low")} />
                      <SecurityStatusBadge status={String(r["status"])} />
                      {mayReview && next.length > 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setReviewing(r);
                            setReviewStatus(next[0] ?? "");
                            setReviewAction(securityStr(r["action_taken"], ""));
                            setReviewNotes("");
                          }}
                        >
                          Review
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <p className="mt-3 text-sm">{securityStr(r["description"])}</p>
                  <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    {r["people_involved"] ? (
                      <p>People involved: {securityStr(r["people_involved"])}</p>
                    ) : null}
                    {r["witnesses"] ? <p>Witnesses: {securityStr(r["witnesses"])}</p> : null}
                    {r["action_taken"] ? (
                      <p>Action taken: {securityStr(r["action_taken"])}</p>
                    ) : null}
                    {r["escalation_notes"] ? (
                      <p>Escalation: {securityStr(r["escalation_notes"])}</p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Report a security incident</DialogTitle>
            <DialogDescription>
              Record what happened while it is fresh. The Security Supervisor takes it from here.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INCIDENT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {titleCase(c.replace(/-/g, " "))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Severity</Label>
                <Select value={severity} onValueChange={setSeverity}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INCIDENT_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {titleCase(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="incident-location">Location</Label>
              <Input
                id="incident-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Rear parking, corridor 2, main gate…"
              />
            </div>
            <div className="grid gap-2">
              <Label>Post</Label>
              <Select value={postId} onValueChange={setPostId}>
                <SelectTrigger>
                  <SelectValue placeholder="No specific post" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific post</SelectItem>
                  {((posts.data ?? []) as SecurityRow[]).map((p) => (
                    <SelectItem key={String(p["id"])} value={String(p["id"])}>
                      {securityStr(p["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="incident-description">What happened</Label>
              <Textarea
                id="incident-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="incident-people">People involved</Label>
              <Input
                id="incident-people"
                value={people}
                onChange={(e) => setPeople(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="incident-witnesses">Witnesses</Label>
              <Input
                id="incident-witnesses"
                value={witnesses}
                onChange={(e) => setWitnesses(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="incident-action">Action taken at the scene</Label>
              <Textarea
                id="incident-action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={report.isPending || !description.trim()}>
              File report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(reviewing)} onOpenChange={(o) => !o && setReviewing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Review {securityStr(reviewing?.["incident_number"])}</DialogTitle>
            <DialogDescription>
              Serious matters escalate to the Operations Manager. An incident can only move forward.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>Move to</Label>
              <Select value={reviewStatus} onValueChange={setReviewStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {nextIncidentStatuses(String(reviewing?.["status"] ?? "")).map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="review-action">Action taken</Label>
              <Textarea
                id="review-action"
                value={reviewAction}
                onChange={(e) => setReviewAction(e.target.value)}
                rows={3}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="review-notes">Escalation notes</Label>
              <Textarea
                id="review-notes"
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>
              Cancel
            </Button>
            <Button onClick={submitReview} disabled={review.isPending || !reviewStatus}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

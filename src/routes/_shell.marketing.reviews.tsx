import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Star } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, MetricTile, NotConfigured } from "@/components/marketing/MarketingShared";
import {
  useCreateReview,
  useMarketingSettings,
  useReviewResponseAction,
  useReviews,
  useSaveReviewResponse,
} from "@/lib/marketing-data";
import {
  EXTERNAL_REVIEW_SOURCES,
  REVIEW_SOURCES,
  REVIEW_STATUSES,
  formatDate,
  titleCase,
} from "@/lib/marketing";
import { useAuth } from "@/lib/auth";
import { NeoDatePicker } from "@/components/common/DatePicker";

export const Route = createFileRoute("/_shell/marketing/reviews")({
  head: () => ({
    meta: [
      { title: "Reviews & Reputation — Marketing & CRM" },
      {
        name: "description",
        content:
          "Manage guest reviews, draft approved responses and track reputation across recorded sources.",
      },
      { property: "og:title", content: "Reviews & Reputation — Marketing & CRM" },
      { property: "og:description", content: "Review inbox with approval-gated public responses." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { can } = useAuth();
  const [status, setStatus] = useState("all");
  const { data: reviews } = useReviews(status === "all" ? {} : { status });
  const { data: settings } = useMarketingSettings();
  const [open, setOpen] = useState(false);

  const rows = (reviews ?? []) as Row[];
  const rated = rows.filter((r) => r["rating"] != null);
  const avg = rated.length
    ? rated.reduce((s, r) => s + Number(r["rating"]), 0) / rated.length
    : null;
  const awaiting = rows.filter((r) =>
    ["new", "pending_approval"].includes(String(r["status"])),
  ).length;
  const externalConfigured = EXTERNAL_REVIEW_SOURCES.some(
    (s) => String(settings?.[`${s}_status`] ?? "not_configured") === "configured",
  );

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Reviews & Reputation"
        description="Only reviews recorded in this system or entered by staff are shown. Nothing is imported from an external review site unless that integration is configured, and no response is published without approval."
        actions={
          can("marketing", "create") ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1.5 size-4" /> Log review
            </Button>
          ) : null
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <MetricTile label="Reviews recorded" value={String(rows.length)} />
        <MetricTile label="Average rating" value={avg == null ? "—" : `${avg.toFixed(2)} / 5`} />
        <MetricTile
          label="Awaiting response"
          value={String(awaiting)}
          tone={awaiting ? "warning" : "default"}
        />
      </div>

      {!externalConfigured ? (
        <div className="mb-6">
          <NotConfigured
            channel="External review sites"
            detail="Google, Booking.com and Tripadvisor reviews are not imported. Staff can log them manually until an integration is configured."
          />
        </div>
      ) : null}

      <div className="mb-4 w-56">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {REVIEW_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {titleCase(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SectionCard title="Review inbox">
        {!rows.length ? (
          <EmptyState
            icon={Star}
            title="No reviews recorded"
            description="Reviews submitted through feedback requests or logged by staff appear here."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <ReviewCard key={String(r["id"])} review={r} />
            ))}
          </ul>
        )}
      </SectionCard>

      <LogDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function ReviewCard({ review }: { review: Row }) {
  const { can } = useAuth();
  const save = useSaveReviewResponse();
  const act = useReviewResponseAction();
  const [draft, setDraft] = useState("");
  const responses = (review["review_responses"] ?? []) as Row[];
  const pending = responses.find((r) => String(r["status"]) === "pending_approval");
  const approved = responses.find((r) => String(r["status"]) === "approved");

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-foreground">
            {review["customers"]?.full_name ?? String(review["reviewer_name"] ?? "Guest")}
          </p>
          <p className="text-xs text-muted-foreground">
            {titleCase(String(review["source"]))} · {formatDate(review["review_date"])}
            {review["rating"] != null ? ` · ${Number(review["rating"])}/5` : ""}
          </p>
        </div>
        <StatusPill tone={String(review["status"]) === "responded" ? "success" : "warning"}>
          {titleCase(String(review["status"]))}
        </StatusPill>
      </div>
      {review["body"] ? (
        <p className="mt-2 text-sm text-muted-foreground">{String(review["body"])}</p>
      ) : null}

      {pending ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Draft awaiting approval
          </p>
          <p className="mt-1 whitespace-pre-wrap">{String(pending["draft_body"])}</p>
          {can("marketing", "approve") ? (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  act.mutate({
                    id: String(pending["id"]),
                    reviewId: String(review["id"]),
                    action: "approved",
                  })
                }
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  act.mutate({
                    id: String(pending["id"]),
                    reviewId: String(review["id"]),
                    action: "rejected",
                  })
                }
              >
                Reject
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {approved ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">Approved response ready to publish.</p>
          <Button
            size="sm"
            onClick={() =>
              act.mutate({
                id: String(approved["id"]),
                reviewId: String(review["id"]),
                action: "published",
                channel: String(review["source"]),
              })
            }
          >
            Mark as published
          </Button>
        </div>
      ) : null}

      {!pending && !approved && can("marketing", "create") ? (
        <div className="mt-3 space-y-2">
          <Label className="text-xs">Draft a response</Label>
          <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button
            size="sm"
            disabled={!draft || save.isPending}
            onClick={() =>
              save.mutate(
                { reviewId: String(review["id"]), body: draft, aiAssisted: false },
                { onSuccess: () => setDraft("") },
              )
            }
          >
            Submit for approval
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function LogDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const create = useCreateReview();
  const [form, setForm] = useState<Row>({
    source: "internal",
    status: "new",
    review_date: new Date().toISOString().slice(0, 10),
  });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a review</DialogTitle>
          <DialogDescription>
            Record a review received offline or on a site without an integration.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Source</Label>
            <Select value={String(form["source"])} onValueChange={(v) => set("source", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REVIEW_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Reviewer name</Label>
            <Input
              value={String(form["reviewer_name"] ?? "")}
              onChange={(e) => set("reviewer_name", e.target.value)}
            />
          </div>
          <div>
            <Label>Rating (1–5)</Label>
            <Input
              type="number"
              min={1}
              max={5}
              onChange={(e) => set("rating", Number(e.target.value || 0))}
            />
          </div>
          <div>
            <Label>Review date</Label>
            <NeoDatePicker
              value={String(form["review_date"])}
              onChange={(v) => set("review_date", v)}
            />
          </div>
          <div>
            <Label>Review text</Label>
            <Textarea
              rows={3}
              value={String(form["body"] ?? "")}
              onChange={(e) => set("body", e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={create.isPending}
            onClick={() => create.mutate(form, { onSuccess: () => onOpenChange(false) })}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/reviews">
      <Page />
    </OpsGuard>
  );
}

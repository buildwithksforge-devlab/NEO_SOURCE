import { useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { Megaphone } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/operations";
import {
  MKT_CHANNELS,
  MKT_CONTENT_TYPES,
  str,
  useCreateMarketingContent,
  useMarketingCampaignOptions,
  useMarketingContent,
  usePublishMarketingContent,
  useReviewMarketingContent,
  useScheduleMarketingContent,
  useSubmitMarketingContent,
  type MktRow,
} from "@/lib/marketing-department";

export const Route = createFileRoute("/_shell/marketing/content")({
  head: () => ({
    meta: [
      { title: "Marketing Content — NEØ" },
      {
        name: "description",
        content:
          "Draft social posts, send them for approval and publish only what the Marketing Manager has signed off.",
      },
      { property: "og:title", content: "Marketing Content — NEØ" },
      {
        property: "og:description",
        content: "One approval trail from draft to published post across every social channel.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="marketing" action="content.view">
      <MarketingContentPage />
    </OpsGuard>
  ),
});

const TONE: Record<string, "default" | "success" | "warning" | "info" | "destructive"> = {
  draft: "default",
  submitted: "warning",
  returned: "warning",
  approved: "info",
  scheduled: "info",
  published: "success",
  rejected: "destructive",
};

function MarketingContentPage() {
  const { can, user } = useAuth();
  const mayApprove = can("marketing", "content.approve");
  const mayPublish = can("marketing", "content.approve");
  const mayDraft = can("marketing", "content.create");

  const content = useMarketingContent("all");
  const campaigns = useMarketingCampaignOptions();
  const create = useCreateMarketingContent();
  const submit = useSubmitMarketingContent();
  const review = useReviewMarketingContent();
  const schedule = useScheduleMarketingContent();
  const publish = usePublishMarketingContent();

  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState<string>("instagram");
  const [contentType, setContentType] = useState<string>("post");
  const [campaignId, setCampaignId] = useState<string>("none");
  const [plannedFor, setPlannedFor] = useState("");
  const [body, setBody] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");

  const rows = (content.data ?? []) as MktRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Marketing"
        title="Content & approvals"
        description="Social Media Managers draft here. Nothing reaches a channel until the Marketing Manager approves it, and nobody approves their own work."
      />

      {mayDraft ? (
        <SectionCard
          title="New content draft"
          description="Save a draft, then send it up for approval."
        >
          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="content-title">Title</Label>
              <Input
                id="content-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Weekend brunch reel"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MKT_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {titleCase(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Format</Label>
              <Select value={contentType} onValueChange={setContentType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MKT_CONTENT_TYPES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {titleCase(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Campaign</Label>
              <Select value={campaignId} onValueChange={setCampaignId}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No campaign</SelectItem>
                  {((campaigns.data ?? []) as MktRow[]).map((c) => (
                    <SelectItem key={String(c["id"])} value={String(c["id"])}>
                      {str(c["name"], "Campaign")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="content-planned">Planned for</Label>
              <NeoDatePicker id="content-planned" value={plannedFor} onChange={setPlannedFor} />
            </div>
            <div className="space-y-1.5 md:col-span-4">
              <Label htmlFor="content-body">Caption / copy</Label>
              <Textarea
                id="content-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                placeholder="Write the caption exactly as it should be published."
              />
            </div>
            <div className="md:col-span-4">
              <Button
                disabled={!title.trim() || create.isPending}
                onClick={() =>
                  create.mutate(
                    {
                      title,
                      channel,
                      contentType,
                      body,
                      campaignId: campaignId === "none" ? null : campaignId,
                      plannedFor: plannedFor || null,
                    },
                    {
                      onSuccess: () => {
                        setTitle("");
                        setBody("");
                        setPlannedFor("");
                      },
                    },
                  )
                }
              >
                Save draft
              </Button>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {mayPublish ? (
        <SectionCard
          title="Publish slot"
          description="Set the date and time used when scheduling approved content."
        >
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="content-slot">Scheduled for</Label>
              <Input
                id="content-slot"
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
              />
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Content pipeline" description="Newest first, across every channel.">
        <QueryState
          isLoading={content.isLoading}
          error={content.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No content yet"
              description="Save a draft to start the approval trail."
              icon={Megaphone}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Content</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Planned</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const id = String(row["id"]);
                  const status = str(row["status"], "draft");
                  const mine = String(row["created_by"] ?? "") === String(user?.id ?? "");
                  const busy =
                    submit.isPending || review.isPending || schedule.isPending || publish.isPending;
                  return (
                    <TableRow key={id}>
                      <TableCell>
                        <p className="font-medium">{str(row["title"])}</p>
                        <p className="max-w-md truncate text-xs text-muted-foreground">
                          {str(row["review_notes"]) !== "—"
                            ? `Note: ${str(row["review_notes"])}`
                            : str(row["body"], "No caption")}
                        </p>
                      </TableCell>
                      <TableCell>
                        {titleCase(str(row["channel"], "other"))}
                        <span className="block text-xs text-muted-foreground">
                          {titleCase(str(row["content_type"], "post"))}
                        </span>
                      </TableCell>
                      <TableCell>{String(row["planned_for"] ?? "").slice(0, 10) || "—"}</TableCell>
                      <TableCell>
                        <StatusPill tone={TONE[status] ?? "default"}>
                          {titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {mine && ["draft", "returned"].includes(status) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => submit.mutate(id)}
                            >
                              Send for approval
                            </Button>
                          ) : null}
                          {mayApprove && status === "submitted" && !mine ? (
                            <>
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  review.mutate({ contentId: id, decision: "approve" })
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => review.mutate({ contentId: id, decision: "return" })}
                              >
                                Return
                              </Button>
                            </>
                          ) : null}
                          {mayPublish && status === "approved" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || !scheduledFor}
                              onClick={() => schedule.mutate({ contentId: id, scheduledFor })}
                            >
                              Schedule
                            </Button>
                          ) : null}
                          {mayPublish && ["approved", "scheduled"].includes(status) ? (
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => publish.mutate({ contentId: id })}
                            >
                              Mark published
                            </Button>
                          ) : null}
                          {status === "published" ? (
                            <span className="text-xs text-muted-foreground">
                              {String(row["published_at"] ?? "").slice(0, 10)}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

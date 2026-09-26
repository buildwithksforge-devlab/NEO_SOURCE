import { useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Megaphone, Plus } from "lucide-react";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
import { EmptyState, MetricTile, NotConfigured } from "@/components/marketing/MarketingShared";
import {
  useBuildAudience,
  useCampaignAudience,
  useCampaignStatus,
  useCampaigns,
  useCreateCampaign,
  useLaunchCampaign,
  useMarketingSettings,
  useMessageTemplates,
  useSegments,
  useSendTest,
} from "@/lib/marketing-data";
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  campaignStatusLabels,
  campaignTone,
  formatDateTime,
  invalidVariables,
  renderPreview,
  supportedStatusesByChannel,
  TEMPLATE_VARIABLES,
  titleCase,
} from "@/lib/marketing";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/marketing/campaigns")({
  head: () => ({
    meta: [
      { title: "Campaigns — Marketing & CRM" },
      {
        name: "description",
        content:
          "Build, approve and launch consent-checked email, SMS and WhatsApp campaigns to frozen audiences.",
      },
      { property: "og:title", content: "Campaigns — Marketing & CRM" },
      {
        property: "og:description",
        content: "Consent-checked campaign build, approval and delivery.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;
const CHANNELS = ["email", "sms", "whatsapp", "push", "in_app"];

function Page() {
  const { can } = useAuth();
  const [status, setStatus] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const { data: campaigns, isLoading } = useCampaigns(status === "all" ? undefined : status);

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Campaigns"
        description="A campaign can only be launched once it has an approved definition and a frozen audience. Every recipient is re-checked against consent, suppression, frequency caps and quiet hours before queueing."
        actions={
          can("marketing", "create") ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-4" /> New campaign
            </Button>
          ) : null
        }
      />

      <div className="mb-4 w-56">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {CAMPAIGN_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {campaignStatusLabels[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SectionCard title="Campaign register">
        {isLoading ? (
          <LoadingState variant="rows" rows={5} />
        ) : !campaigns?.length ? (
          <EmptyState
            icon={Megaphone}
            title="No campaigns yet"
            description="Create a campaign to target a segment on a permitted channel. Nothing is sent until you approve and launch it."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Segment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scheduled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(campaigns as Row[]).map((c) => (
                  <TableRow
                    key={String(c["id"])}
                    className="cursor-pointer"
                    onClick={() => setSelected(c)}
                  >
                    <TableCell>
                      <p className="font-medium text-foreground">{String(c["name"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {String(c["campaign_number"])}
                      </p>
                    </TableCell>
                    <TableCell>{titleCase(String(c["channel"]))}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c["customer_segments"]?.name ?? "All consented customers"}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={campaignTone(String(c["status"]))}>
                        {campaignStatusLabels[
                          String(c["status"]) as keyof typeof campaignStatusLabels
                        ] ?? titleCase(String(c["status"]))}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-sm">{formatDateTime(c["scheduled_at"])}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CampaignDrawer campaign={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function CreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const create = useCreateCampaign();
  const { data: segments } = useSegments();
  const [form, setForm] = useState<Row>({
    channel: "email",
    campaign_type: "promotional",
    objective: "revenue",
    status: "draft",
  });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>
            The campaign is created as a draft. Content, audience and approval are handled on the
            campaign record.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label>Campaign name</Label>
            <Input
              value={String(form["name"] ?? "")}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <div>
            <Label>Channel</Label>
            <Select value={String(form["channel"])} onValueChange={(v) => set("channel", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Type</Label>
            <Select
              value={String(form["campaign_type"])}
              onValueChange={(v) => set("campaign_type", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAMPAIGN_TYPES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Objective</Label>
            <Select value={String(form["objective"])} onValueChange={(v) => set("objective", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAMPAIGN_OBJECTIVES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Segment</Label>
            <Select
              value={String(form["segment_id"] ?? "")}
              onValueChange={(v) => set("segment_id", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="All consented customers" />
              </SelectTrigger>
              <SelectContent>
                {(segments ?? []).map((s: Row) => (
                  <SelectItem key={String(s["id"])} value={String(s["id"])}>
                    {String(s["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Scheduled send</Label>
            <Input
              type="datetime-local"
              onChange={(e) =>
                set("scheduled_at", e.target.value ? new Date(e.target.value).toISOString() : null)
              }
            />
          </div>
          <div>
            <Label>Planned budget</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              onChange={(e) => set("budget", Number(e.target.value || 0))}
            />
          </div>
          <div className="sm:col-span-2">
            <Label>Subject / title</Label>
            <Input
              value={String(form["subject"] ?? "")}
              onChange={(e) => set("subject", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label>Message body</Label>
            <Textarea
              rows={5}
              value={String(form["body"] ?? "")}
              onChange={(e) => set("body", e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Allowed variables: {TEMPLATE_VARIABLES.map((v) => v.token).join(", ")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form["name"] || create.isPending}
            onClick={() => create.mutate(form, { onSuccess: () => onOpenChange(false) })}
          >
            {create.isPending ? "Saving…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CampaignDrawer({ campaign, onClose }: { campaign: Row | null; onClose: () => void }) {
  const { can } = useAuth();
  const id = campaign ? String(campaign["id"]) : undefined;
  const { data: audience } = useCampaignAudience(id);
  const { data: settings } = useMarketingSettings();
  const { data: templates } = useMessageTemplates(
    campaign ? String(campaign["channel"]) : undefined,
  );
  const build = useBuildAudience();
  const test = useSendTest();
  const launch = useLaunchCampaign();
  const statusMutation = useCampaignStatus();
  const [testRecipient, setTestRecipient] = useState("");

  if (!campaign) return null;

  const channel = String(campaign["channel"]);
  const providerKey = `${channel}_status`;
  const providerStatus = String(settings?.[providerKey] ?? "not_configured");
  const subject = String(campaign["subject"] ?? campaign["name"]);
  const body = String(campaign["body"] ?? "");
  const bad = invalidVariables(body);
  const rows = (audience ?? []) as Row[];
  const eligible = rows.filter((a) => a["eligible"] === true).length;
  const excluded = rows.length - eligible;

  return (
    <Sheet open={Boolean(campaign)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{String(campaign["name"])}</SheetTitle>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-10">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={campaignTone(String(campaign["status"]))}>
              {campaignStatusLabels[
                String(campaign["status"]) as keyof typeof campaignStatusLabels
              ] ?? titleCase(String(campaign["status"]))}
            </StatusPill>
            <span className="text-xs text-muted-foreground">
              {String(campaign["campaign_number"])}
            </span>
          </div>

          {providerStatus !== "configured" ? <NotConfigured channel={titleCase(channel)} /> : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile label="Audience frozen" value={String(rows.length)} />
            <MetricTile label="Eligible" value={String(eligible)} tone="success" />
            <MetricTile
              label="Excluded"
              value={String(excluded)}
              tone={excluded ? "warning" : "default"}
            />
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Message preview
            </p>
            <div className="mt-1 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{subject}</p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {renderPreview(body, {
                  first_name: "Amina",
                  hotel_name: "your hotel",
                  offer_name: "Weekend escape",
                })}
              </p>
            </div>
            {bad.length ? (
              <p className="mt-1 text-xs text-destructive">
                Unsupported variables will not be substituted: {bad.join(", ")}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Reportable delivery statuses on {titleCase(channel)}:{" "}
              {(supportedStatusesByChannel[channel] ?? ["queued"]).join(", ")}. Anything else is
              never inferred.
            </p>
          </div>

          {templates?.length ? (
            <p className="text-xs text-muted-foreground">
              {templates.length} approved {titleCase(channel)} template(s) available in Message
              Templates.
            </p>
          ) : null}

          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">1 · Freeze the audience</p>
            <p className="text-xs text-muted-foreground">
              Each candidate is checked server-side for consent, suppression, frequency caps and
              quiet hours. Ineligible customers are stored with their exclusion reason rather than
              silently dropped.
            </p>
            <Button
              size="sm"
              disabled={build.isPending}
              onClick={() =>
                build.mutate({
                  campaignId: String(campaign["id"]),
                  segmentId: (campaign["segment_id"] as string | null) ?? null,
                  channel,
                })
              }
            >
              {build.isPending ? "Checking eligibility…" : "Freeze audience"}
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">2 · Internal test send</p>
            <div className="flex gap-2">
              <Input
                placeholder={channel === "email" ? "staff@example.com" : "+254…"}
                value={testRecipient}
                onChange={(e) => setTestRecipient(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!testRecipient || test.isPending}
                onClick={() =>
                  test.mutate(
                    {
                      campaignId: String(campaign["id"]),
                      recipients: [testRecipient],
                      channel,
                      subject,
                      body,
                    },
                    { onSuccess: () => setTestRecipient("") },
                  )
                }
              >
                Send test
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Test messages are flagged as tests, excluded from reporting, and never issue vouchers
              or points.
            </p>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">3 · Approval and launch</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  statusMutation.mutate({ id: String(campaign["id"]), status: "pending_approval" })
                }
              >
                Submit for approval
              </Button>
              {can("marketing", "approve") ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    statusMutation.mutate({ id: String(campaign["id"]), status: "approved" })
                  }
                >
                  Approve
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={
                  launch.isPending || String(campaign["status"]) !== "approved" || eligible === 0
                }
                onClick={() => launch.mutate({ campaign, subject, body })}
              >
                {launch.isPending ? "Queueing…" : "Launch"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  statusMutation.mutate({ id: String(campaign["id"]), status: "paused" })
                }
              >
                Pause
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  statusMutation.mutate({ id: String(campaign["id"]), status: "cancelled" })
                }
              >
                Cancel
              </Button>
            </div>
            {String(campaign["status"]) !== "approved" ? (
              <p className="text-xs text-muted-foreground">
                Launch is disabled until the campaign is approved.
              </p>
            ) : null}
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Frozen audience ({rows.length})
            </p>
            {!rows.length ? (
              <p className="text-sm text-muted-foreground">No audience frozen yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {rows.slice(0, 50).map((a) => (
                  <li
                    key={String(a["id"])}
                    className="flex items-center justify-between rounded-lg border border-border px-3 py-1.5"
                  >
                    <span>{a["customers"]?.full_name ?? "Customer"}</span>
                    {a["eligible"] ? (
                      <StatusPill tone="success">{titleCase(String(a["status"]))}</StatusPill>
                    ) : (
                      <StatusPill tone="warning">
                        {titleCase(String(a["exclusion_reason"] ?? "excluded"))}
                      </StatusPill>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/campaigns">
      <Page />
    </OpsGuard>
  );
}

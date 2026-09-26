import { useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2, Workflow } from "lucide-react";
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
import { EmptyState } from "@/components/marketing/MarketingShared";
import {
  useAddJourneyStep,
  useCreateJourney,
  useDeleteJourneyStep,
  useJourneySteps,
  useJourneyStatus,
  useJourneys,
} from "@/lib/marketing-data";
import {
  JOURNEY_STEP_TYPES,
  JOURNEY_TRIGGERS,
  journeyStepLabels,
  titleCase,
} from "@/lib/marketing";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/marketing/automations")({
  head: () => ({
    meta: [
      { title: "Automations — Marketing & CRM" },
      {
        name: "description",
        content:
          "Guest journeys triggered by real operational events, with consent checks on every step.",
      },
      { property: "og:title", content: "Automations — Marketing & CRM" },
      {
        property: "og:description",
        content: "Event-triggered guest journeys with consent enforcement.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { can } = useAuth();
  const { data: journeys, isLoading } = useJourneys();
  const [createOpen, setCreateOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const status = useJourneyStatus();

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Automations"
        description="Journeys react to recorded events such as a completed stay, a birthday or an inactivity threshold. Every step re-checks consent, suppression and frequency caps before a message leaves the queue, and each customer can enter a journey once per period."
        actions={
          can("marketing", "create") ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-4" /> New journey
            </Button>
          ) : null
        }
      />

      {isLoading ? (
        <LoadingState variant="cards" rows={3} />
      ) : !journeys?.length ? (
        <SectionCard title="Journeys">
          <EmptyState
            icon={Workflow}
            title="No journeys yet"
            description="Create a journey such as a post-stay thank-you or a win-back sequence. Journeys start as drafts and never send until activated."
          />
        </SectionCard>
      ) : (
        <div className="space-y-4">
          {(journeys as Row[]).map((j) => (
            <SectionCard
              key={String(j["id"])}
              title={String(j["name"])}
              description={`Trigger: ${titleCase(String(j["trigger_event"]))}${j["description"] ? ` · ${String(j["description"])}` : ""}`}
              actions={
                <div className="flex items-center gap-2">
                  <StatusPill tone={String(j["status"]) === "active" ? "success" : "default"}>
                    {titleCase(String(j["status"]))}
                  </StatusPill>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      status.mutate({
                        id: String(j["id"]),
                        status: String(j["status"]) === "active" ? "paused" : "active",
                      })
                    }
                  >
                    {String(j["status"]) === "active" ? "Pause" : "Activate"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setActiveId(String(j["id"]))}>
                    Steps
                  </Button>
                </div>
              }
            >
              <JourneySteps journeyId={String(j["id"])} expanded={activeId === String(j["id"])} />
            </SectionCard>
          ))}
        </div>
      )}

      <CreateJourneyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function JourneySteps({ journeyId, expanded }: { journeyId: string; expanded: boolean }) {
  const { data: steps } = useJourneySteps(journeyId);
  const add = useAddJourneyStep();
  const remove = useDeleteJourneyStep();
  const [type, setType] = useState("send_message");
  const [channel, setChannel] = useState("email");
  const [delay, setDelay] = useState("0");
  const [body, setBody] = useState("");

  const rows = (steps ?? []) as Row[];

  return (
    <div>
      {!rows.length ? (
        <p className="text-sm text-muted-foreground">
          No steps defined — this journey cannot send anything yet.
        </p>
      ) : (
        <ol className="space-y-2">
          {rows.map((s, i) => (
            <li
              key={String(s["id"])}
              className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <div>
                <p className="font-medium text-foreground">
                  {i + 1}.{" "}
                  {journeyStepLabels[String(s["step_type"])] ?? titleCase(String(s["step_type"]))}
                  {s["channel"] ? ` · ${titleCase(String(s["channel"]))}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  Delay {Number(s["delay_hours"] ?? 0)}h
                  {s["body"] ? ` · ${String(s["body"]).slice(0, 80)}` : ""}
                </p>
              </div>
              <Button size="icon" variant="ghost" onClick={() => remove.mutate(String(s["id"]))}>
                <Trash2 className="size-4 text-muted-foreground" />
              </Button>
            </li>
          ))}
        </ol>
      )}

      {expanded ? (
        <div className="mt-4 grid gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-4">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {JOURNEY_STEP_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {journeyStepLabels[t] ?? titleCase(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["email", "sms", "whatsapp", "in_app"].map((c) => (
                <SelectItem key={c} value={c}>
                  {titleCase(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={0}
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            placeholder="Delay hours"
          />
          <Button
            onClick={() =>
              add.mutate(
                {
                  journey_id: journeyId,
                  position: rows.length + 1,
                  step_type: type,
                  channel,
                  delay_hours: Number(delay || 0),
                  body,
                },
                { onSuccess: () => setBody("") },
              )
            }
          >
            Add step
          </Button>
          <Textarea
            className="sm:col-span-4"
            rows={2}
            placeholder="Message body (only whitelisted variables are substituted)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}

function CreateJourneyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const create = useCreateJourney();
  const [form, setForm] = useState<Row>({ trigger_event: "stay_completed", status: "draft" });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New journey</DialogTitle>
          <DialogDescription>
            Journeys are created as drafts. Add steps, then activate when you are satisfied.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input
              value={String(form["name"] ?? "")}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <div>
            <Label>Trigger event</Label>
            <Select
              value={String(form["trigger_event"])}
              onValueChange={(v) => set("trigger_event", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JOURNEY_TRIGGERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              rows={2}
              value={String(form["description"] ?? "")}
              onChange={(e) => set("description", e.target.value)}
            />
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
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/automations">
      <Page />
    </OpsGuard>
  );
}

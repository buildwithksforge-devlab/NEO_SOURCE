import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";
import {
  EVENT_CATALOGUE,
  statusTone,
  titleCase,
  useAutomationRefresh,
  useWorkflows,
} from "@/lib/automation";

export const Route = createFileRoute("/_shell/automation/workflows/")({
  head: () => ({
    meta: [
      { title: "Workflows — Automation Centre" },
      {
        name: "description",
        content: "Create, version, publish and pause hospitality automation workflows.",
      },
      { property: "og:title", content: "Workflows — Automation Centre" },
      {
        property: "og:description",
        content: "Event-driven workflow definitions with versioning and test mode.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function WorkflowsPage() {
  const { profile, user, can, isAdmin } = useAuth();
  const workflows = useWorkflows();
  const refresh = useAutomationRefresh();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    trigger_event: "",
    branch_id: "all",
  });

  const canCreate = can("automation", "create");

  const branches = useQuery({
    queryKey: ["automation", "branches"],
    queryFn: async () => {
      const { data } = await supabase
        .from("branches")
        .select("id, name")
        .eq("active", true)
        .order("name");
      return data ?? [];
    },
  });

  async function create() {
    if (!profile?.organization_id || !form.name.trim() || !form.trigger_event) return;
    const { data, error } = await supabase
      .from("workflow_definitions")
      .insert({
        organization_id: profile.organization_id,
        branch_id: form.branch_id === "all" ? null : form.branch_id,
        name: form.name.trim(),
        description: form.description.trim(),
        trigger_type: "event",
        trigger_event: form.trigger_event,
        status: "draft",
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    const { error: versionError } = await supabase.from("workflow_versions").insert({
      organization_id: profile.organization_id,
      workflow_id: data.id,
      version: 1,
      trigger: { type: "event", event: form.trigger_event },
      conditions: [],
      actions: [],
      created_by: user?.id ?? null,
    });
    if (versionError) toast.error(versionError.message);

    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "automation.workflow.create",
      module: "automation",
      recordId: data.id,
      newValue: { name: form.name, trigger: form.trigger_event },
    });
    setOpen(false);
    setForm({ name: "", description: "", trigger_event: "", branch_id: "all" });
    refresh();
    toast.success("Workflow draft created");
  }

  const rows = workflows.data ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Workflows"
        description="Each workflow reacts to a real recorded business event. Publishing creates a new immutable version; running workflows keep the version they started with."
        actions={
          canCreate ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="size-4" /> New workflow
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New workflow</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>Workflow name</Label>
                    <Input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea
                      rows={2}
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Branch scope</Label>
                    <Select
                      value={form.branch_id}
                      onValueChange={(v) => setForm({ ...form, branch_id: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All branches</SelectItem>
                        {(branches.data ?? []).map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Trigger event</Label>
                    <Select
                      value={form.trigger_event}
                      onValueChange={(v) => setForm({ ...form, trigger_event: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a business event" />
                      </SelectTrigger>
                      <SelectContent>
                        {EVENT_CATALOGUE.map((e) => (
                          <SelectItem key={e.type} value={e.type} disabled={!e.live}>
                            {e.group} · {e.label}
                            {e.live ? "" : " (module not yet live)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={create} disabled={!form.name.trim() || !form.trigger_event}>
                    Create draft
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null
        }
      />

      <SectionCard
        title="Workflow library"
        description={`${rows.length} workflow(s) in this organisation`}
      >
        {workflows.isLoading ? (
          <LoadingState variant="cards" rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No workflows yet"
            description="Create one to react automatically to reservations, payments, check-ins, tasks or feedback."
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {rows.map((w) => (
              <li key={w.id} className="rounded-xl border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to="/automation/workflows/$id"
                      params={{ id: w.id }}
                      className="font-medium hover:underline"
                    >
                      {w.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {w.trigger_event ? titleCase(w.trigger_event) : "No trigger"} · v
                      {w.published_version ?? w.current_version}
                    </p>
                    {w.description ? (
                      <p className="mt-1 text-sm text-muted-foreground">{w.description}</p>
                    ) : null}
                  </div>
                  <StatusPill tone={statusTone(w.status)}>{titleCase(w.status)}</StatusPill>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {w.successful_runs} successful · {w.failed_runs} failed ·{" "}
                  {w.last_run_at
                    ? `last run ${new Date(w.last_run_at).toLocaleString()}`
                    : "never run"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/workflows">
      <WorkflowsPage />
    </OpsGuard>
  );
}

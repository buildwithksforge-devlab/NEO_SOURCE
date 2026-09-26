import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
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
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { EmptyState, LoadingState, NotAuthorisedState } from "@/components/common/StateSystem";
import {
  MESSAGE_CHANNELS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_STATUSES,
  TEMPLATE_VARIABLES,
  extractVariables,
  previewTemplate,
  statusTone,
  titleCase,
  useAutomationRefresh,
  useMessageTemplates,
} from "@/lib/automation";

export const Route = createFileRoute("/_shell/automation/templates")({
  head: () => ({
    meta: [
      { title: "Message Templates — Automation Centre" },
      {
        name: "description",
        content: "Branded, versioned guest message templates for email, WhatsApp and SMS.",
      },
      { property: "og:title", content: "Message Templates — Automation Centre" },
      {
        property: "og:description",
        content: "Multi-channel template library with variables, versions and approval status.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const EMPTY = {
  key: "",
  name: "",
  category: "reservation",
  channel: "email",
  language: "en",
  subject: "",
  body: "",
  is_marketing: false,
  status: "draft",
};

function TemplatesPage() {
  const { profile, user, can, isAdmin } = useAuth();
  const templates = useMessageTemplates();
  const refresh = useAutomationRefresh();
  const [form, setForm] = useState({ ...EMPTY });
  const [editingId, setEditingId] = useState<string | null>(null);

  const canEdit = can("automation", "edit");
  const used = extractVariables(`${form.subject} ${form.body}`);
  const unknown = used.filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v));

  async function save() {
    if (!profile?.organization_id || !form.key.trim() || !form.name.trim() || !form.body.trim())
      return;
    if (unknown.length) {
      toast.error(`Unknown variable(s): ${unknown.join(", ")}`);
      return;
    }
    const payload = {
      organization_id: profile.organization_id,
      key: form.key.trim(),
      name: form.name.trim(),
      category: form.category,
      channel: form.channel,
      language: form.language,
      subject: form.subject.trim(),
      body: form.body,
      allowed_variables: used,
      is_marketing: form.is_marketing,
      status: form.status,
      created_by: user?.id ?? null,
    };
    const query = editingId
      ? supabase
          .from("message_templates")
          .update(payload)
          .eq("id", editingId)
          .select("id, version")
          .single()
      : supabase.from("message_templates").insert(payload).select("id, version").single();
    const { data, error } = await query;
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("message_template_versions").insert({
      organization_id: profile.organization_id,
      template_id: data.id,
      version: (data.version ?? 1) as number,
      subject: form.subject,
      body: form.body,
      status: form.status,
      created_by: user?.id ?? null,
    });
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: editingId ? "automation.template.update" : "automation.template.create",
      module: "automation",
      recordId: data.id,
      newValue: { key: form.key, channel: form.channel, status: form.status },
    });
    setForm({ ...EMPTY });
    setEditingId(null);
    refresh();
    toast.success("Template saved");
  }

  const rows = templates.data ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Message templates"
        description="Templates carry your branding and merge variables. Marketing templates are only used when the customer has given consent."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <SectionCard title="Template library" description={`${rows.length} template(s)`}>
          {templates.isLoading ? (
            <LoadingState rows={3} />
          ) : rows.length === 0 ? (
            <EmptyState inline title="No templates created" description="No message templates have been created yet." />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {rows.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {t.name} <span className="text-xs text-muted-foreground">({t.key})</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {titleCase(t.channel)} · {titleCase(t.category)} · v{t.version}
                      {t.is_marketing ? " · Marketing" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={statusTone(t.status)}>{titleCase(t.status)}</StatusPill>
                    {canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(t.id);
                          setForm({
                            key: t.key,
                            name: t.name,
                            category: t.category,
                            channel: t.channel,
                            language: t.language ?? "en",
                            subject: t.subject ?? "",
                            body: t.body ?? "",
                            is_marketing: Boolean(t.is_marketing),
                            status: t.status,
                          });
                        }}
                      >
                        Edit
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title={editingId ? "Edit template" : "New template"}>
          {!canEdit ? (
            <NotAuthorisedState inline subject="editing message templates" />
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>Key</Label>
                  <Input
                    value={form.key}
                    onChange={(e) => setForm({ ...form, key: e.target.value })}
                    placeholder="booking-confirmation"
                  />
                </div>
                <div>
                  <Label>Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Channel</Label>
                  <Select
                    value={form.channel}
                    onValueChange={(v) => setForm({ ...form, channel: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MESSAGE_CHANNELS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {titleCase(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Category</Label>
                  <Select
                    value={form.category}
                    onValueChange={(v) => setForm({ ...form, category: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEMPLATE_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {titleCase(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Language</Label>
                  <Input
                    value={form.language}
                    onChange={(e) => setForm({ ...form, language: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Status</Label>
                  <Select
                    value={form.status}
                    onValueChange={(v) => setForm({ ...form, status: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEMPLATE_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {titleCase(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Subject / header</Label>
                <Input
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                />
              </div>
              <div>
                <Label>Body</Label>
                <Textarea
                  rows={7}
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_marketing}
                  onChange={(e) => setForm({ ...form, is_marketing: e.target.checked })}
                />
                Marketing template (consent enforced before sending)
              </label>
              <div className="rounded-lg border border-border p-3 text-xs">
                <p className="mb-1 font-medium">Preview</p>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {previewTemplate(form.body) || "—"}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Available variables: {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}
              </p>
              {unknown.length ? (
                <p className="text-xs text-destructive">Unknown variables: {unknown.join(", ")}</p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  onClick={save}
                  disabled={!form.key.trim() || !form.name.trim() || !form.body.trim()}
                >
                  <Plus className="size-4" /> {editingId ? "Save changes" : "Create template"}
                </Button>
                {editingId ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditingId(null);
                      setForm({ ...EMPTY });
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/templates">
      <TemplatesPage />
    </OpsGuard>
  );
}

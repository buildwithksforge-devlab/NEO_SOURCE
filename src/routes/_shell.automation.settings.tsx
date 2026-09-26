import { useEffect, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { useAutomationRefresh, useAutomationSettings } from "@/lib/automation";

export const Route = createFileRoute("/_shell/automation/settings")({
  head: () => ({
    meta: [
      { title: "Automation Settings — Automation Centre" },
      {
        name: "description",
        content: "Quiet hours, retry limits, test recipients and the global automation switch.",
      },
      { property: "og:title", content: "Automation Settings — Automation Centre" },
      {
        property: "og:description",
        content: "Tenant-level safety controls for the workflow and communication engine.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const DEFAULTS = {
  timezone: "Africa/Nairobi",
  quiet_hours_start: "21:00",
  quiet_hours_end: "07:00",
  enforce_quiet_hours: true,
  max_message_attempts: 3,
  retry_backoff_seconds: 300,
  max_workflow_depth: 3,
  test_recipient_email: "",
  test_recipient_phone: "",
  automation_enabled: true,
};

function SettingsPage() {
  const { profile, user, can, isAdmin } = useAuth();
  const settings = useAutomationSettings(profile?.organization_id ?? null);
  const refresh = useAutomationRefresh();
  const [form, setForm] = useState({ ...DEFAULTS });
  const canEdit = can("automation", "edit");

  useEffect(() => {
    if (!settings.data) return;
    const row = settings.data as unknown as Record<string, unknown>;
    setForm({
      timezone: (row["timezone"] as string) ?? DEFAULTS.timezone,
      quiet_hours_start: ((row["quiet_hours_start"] as string) ?? DEFAULTS.quiet_hours_start).slice(
        0,
        5,
      ),
      quiet_hours_end: ((row["quiet_hours_end"] as string) ?? DEFAULTS.quiet_hours_end).slice(0, 5),
      enforce_quiet_hours: Boolean(row["enforce_quiet_hours"]),
      max_message_attempts: Number(row["max_message_attempts"] ?? DEFAULTS.max_message_attempts),
      retry_backoff_seconds: Number(row["retry_backoff_seconds"] ?? DEFAULTS.retry_backoff_seconds),
      max_workflow_depth: Number(row["max_workflow_depth"] ?? DEFAULTS.max_workflow_depth),
      test_recipient_email: (row["test_recipient_email"] as string) ?? "",
      test_recipient_phone: (row["test_recipient_phone"] as string) ?? "",
      automation_enabled: Boolean(row["automation_enabled"]),
    });
  }, [settings.data]);

  async function save() {
    if (!profile?.organization_id) return;
    const { error } = await supabase
      .from("automation_settings")
      .upsert(
        { organization_id: profile.organization_id, ...form, updated_by: user?.id ?? null },
        { onConflict: "organization_id" },
      );
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "automation.settings.update",
      module: "automation",
      newValue: form,
    });
    refresh();
    toast.success("Automation settings saved");
  }

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Automation settings"
        description="These controls apply to this organisation only and take effect on the next engine run."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Safety controls">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="enabled">Automation enabled</Label>
              <Switch
                id="enabled"
                checked={form.automation_enabled}
                disabled={!canEdit}
                onCheckedChange={(v) => setForm({ ...form, automation_enabled: v })}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="quiet">Enforce quiet hours for guest messages</Label>
              <Switch
                id="quiet"
                checked={form.enforce_quiet_hours}
                disabled={!canEdit}
                onCheckedChange={(v) => setForm({ ...form, enforce_quiet_hours: v })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Quiet hours start</Label>
                <Input
                  type="time"
                  value={form.quiet_hours_start}
                  disabled={!canEdit}
                  onChange={(e) => setForm({ ...form, quiet_hours_start: e.target.value })}
                />
              </div>
              <div>
                <Label>Quiet hours end</Label>
                <Input
                  type="time"
                  value={form.quiet_hours_end}
                  disabled={!canEdit}
                  onChange={(e) => setForm({ ...form, quiet_hours_end: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Timezone</Label>
              <Input
                value={form.timezone}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Retries, loops and test recipients">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Max message attempts</Label>
                <Input
                  type="number"
                  min={1}
                  value={form.max_message_attempts}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setForm({ ...form, max_message_attempts: Number(e.target.value) })
                  }
                />
              </div>
              <div>
                <Label>Retry backoff (seconds)</Label>
                <Input
                  type="number"
                  min={30}
                  value={form.retry_backoff_seconds}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setForm({ ...form, retry_backoff_seconds: Number(e.target.value) })
                  }
                />
              </div>
            </div>
            <div>
              <Label>Max workflow chain depth (loop protection)</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={form.max_workflow_depth}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, max_workflow_depth: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label>Test recipient email</Label>
              <Input
                value={form.test_recipient_email}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, test_recipient_email: e.target.value })}
              />
            </div>
            <div>
              <Label>Test recipient phone</Label>
              <Input
                value={form.test_recipient_phone}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, test_recipient_phone: e.target.value })}
              />
            </div>
            {canEdit ? <Button onClick={save}>Save settings</Button> : null}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/settings">
      <SettingsPage />
    </OpsGuard>
  );
}

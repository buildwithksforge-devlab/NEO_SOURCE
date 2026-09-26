import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { GripVertical, Plus, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTenant } from "@/lib/tenant";
import { defaultDashboard } from "@/lib/tenant-defaults";
import type { DashboardWidget } from "@/lib/tenant-types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/dashboard-appearance")({
  head: () => ({
    meta: [
      { title: "Dashboard Appearance — System Administration" },
      {
        name: "description",
        content:
          "Personalize sidebar and header colours, card style, layout, welcome message, quick actions and dashboard widgets.",
      },
      { property: "og:title", content: "Dashboard Appearance — System Administration" },
      { property: "og:description", content: "Configure dashboard layout, widgets and quick actions." },
    ],
  }),
  component: DashboardAppearancePage,
});

const optionGroups = [
  { key: "sidebarStyle", label: "Sidebar colours", options: ["dark", "light", "brand"] },
  { key: "headerStyle", label: "Header colours", options: ["translucent", "solid", "brand"] },
  { key: "backgroundStyle", label: "Dashboard background", options: ["ivory", "white", "soft-grey"] },
  { key: "cardStyle", label: "Card style", options: ["elevated", "flat", "outlined"] },
  { key: "layout", label: "Dashboard layout", options: ["comfortable", "compact", "wide"] },
  { key: "chartStyle", label: "Chart appearance", options: ["area", "bar", "line"] },
] as const;

function DashboardAppearancePage() {
  const { tenant, updateDashboard } = useTenant();
  const d = tenant.dashboard;
  const [dragId, setDragId] = useState<string | null>(null);
  const [newAction, setNewAction] = useState("");

  const reorder = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const items = [...d.widgets];
    const from = items.findIndex((w) => w.id === dragId);
    const to = items.findIndex((w) => w.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved!);
    updateDashboard({ widgets: items });
  };

  const toggleWidget = (id: string, enabled: boolean) =>
    updateDashboard({
      widgets: d.widgets.map((w: DashboardWidget) => (w.id === id ? { ...w, enabled } : w)),
    });

  return (
    <div>
      <PageHeader
        eyebrow="Branding"
        title="Dashboard Appearance"
        description="Shape how the operations dashboard looks for this organization. Widget logic arrives in later phases."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                updateDashboard(defaultDashboard);
                toast("Dashboard preferences reset");
              }}
            >
              <RotateCcw className="size-4" />
              Reset
            </Button>
            <span className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Changes save automatically
            </span>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Appearance" description="Chrome, surfaces and density">
          <div className="space-y-5">
            {optionGroups.map((group) => (
              <div key={group.key} className="space-y-2">
                <Label>{group.label}</Label>
                <div className="flex flex-wrap gap-2">
                  {group.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => updateDashboard({ [group.key]: opt } as never)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm capitalize transition-colors",
                        (d as Record<string, unknown>)[group.key] === opt
                          ? "border-primary bg-primary-soft font-medium text-primary"
                          : "border-border hover:bg-muted",
                      )}
                    >
                      {opt.replace("-", " ")}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <div className="space-y-6">
          <SectionCard title="Welcome & banner" description="Greeting shown at the top of the dashboard">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Welcome message</Label>
                <Input
                  value={d.welcomeMessage}
                  onChange={(e) => updateDashboard({ welcomeMessage: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div>
                  <p className="text-sm font-medium">Show dashboard banner</p>
                  <p className="text-xs text-muted-foreground">Uses the banner image from Brand Identity</p>
                </div>
                <Switch
                  checked={d.bannerEnabled}
                  onCheckedChange={(v) => updateDashboard({ bannerEnabled: v })}
                />
              </div>
              <div className="space-y-2">
                <Label>Banner text</Label>
                <Textarea
                  rows={2}
                  value={d.bannerText}
                  onChange={(e) => updateDashboard({ bannerText: e.target.value })}
                />
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Quick actions" description="Buttons pinned to the dashboard header">
            <div className="flex flex-wrap gap-2">
              {d.quickActions.map((action) => (
                <span
                  key={action}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm"
                >
                  {action}
                  <button
                    type="button"
                    aria-label={`Remove ${action}`}
                    onClick={() =>
                      updateDashboard({ quickActions: d.quickActions.filter((a) => a !== action) })
                    }
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <Input
                value={newAction}
                onChange={(e) => setNewAction(e.target.value)}
                placeholder="Add a quick action"
              />
              <Button
                variant="outline"
                onClick={() => {
                  if (!newAction.trim()) return;
                  updateDashboard({ quickActions: [...d.quickActions, newAction.trim()] });
                  setNewAction("");
                }}
              >
                <Plus className="size-4" />
                Add
              </Button>
            </div>
          </SectionCard>
        </div>
      </div>

      <SectionCard
        className="mt-6"
        title="Dashboard widgets"
        description="Drag to reorder, toggle to show or hide. Visual configuration only in Phase 1."
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {d.widgets.map((widget) => (
            <li
              key={widget.id}
              draggable
              onDragStart={() => setDragId(widget.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                reorder(widget.id);
                setDragId(null);
              }}
              className={cn(
                "flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors",
                dragId === widget.id && "opacity-50",
                widget.enabled ? "" : "bg-muted/40",
              )}
            >
              <GripVertical className="size-4 cursor-grab text-muted-foreground" />
              <span className="min-w-0 flex-1 text-sm font-medium">{widget.label}</span>
              <Switch
                checked={widget.enabled}
                onCheckedChange={(v) => toggleWidget(widget.id, v)}
                aria-label={`Toggle ${widget.label}`}
              />
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { RecordDialog } from "@/components/kitchen/RecordDialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { titleCase, type Row } from "@/lib/kitchen";
import {
  useKitchenStations,
  useQualityChecklists,
  useQualityChecks,
  useRecordQualityCheck,
  useSaveChecklist,
} from "@/lib/kitchen-data";

export const Route = createFileRoute("/_shell/kitchen/quality")({
  head: () => ({
    meta: [
      { title: "Quality control — NEØ" },
      {
        name: "description",
        content: "Completed quality checks, failures and active holds across kitchen stations.",
      },
      { property: "og:title", content: "Quality control — NEØ" },
      {
        property: "og:description",
        content: "Completed quality checks, failures and active holds across kitchen stations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="view">
      <Page />
    </KitchenGuard>
  ),
});

function Page() {
  const { can } = useAuth();
  const query = useQualityChecks();
  const checklists = useQualityChecklists();
  const stations = useKitchenStations();
  const recordCheck = useRecordQualityCheck();
  const saveChecklist = useSaveChecklist();
  const rows = (query.data ?? []) as Row[];

  const stationOptions = (stations.data ?? []).map((s) => ({
    value: String(s["id"]),
    label: String(s["name"]),
  }));

  const checkFields = [
    {
      name: "checklist_id",
      label: "Checklist",
      type: "select" as const,
      required: true,
      options: (checklists.data ?? []).map((c) => ({
        value: String(c["id"]),
        label: String(c["name"]),
      })),
    },
    { name: "station_id", label: "Station", type: "select" as const, options: stationOptions },
    {
      name: "result",
      label: "Result",
      type: "select" as const,
      required: true,
      options: ["passed", "passed-with-notes", "failed"].map((r) => ({
        value: r,
        label: titleCase(r),
      })),
    },
    { name: "exceptions", label: "Exceptions observed", type: "textarea" as const },
    { name: "corrective_action", label: "Corrective action", type: "textarea" as const },
  ];

  const checklistFields = [
    { name: "name", label: "Checklist name", required: true },
    { name: "station_id", label: "Station", type: "select" as const, options: stationOptions },
    {
      name: "frequency",
      label: "Frequency",
      type: "select" as const,
      options: ["per-shift", "daily", "weekly", "per-batch"].map((f) => ({
        value: f,
        label: titleCase(f),
      })),
    },
    {
      name: "checklist_type",
      label: "Checklist type",
      type: "select" as const,
      options: ["food-safety", "presentation", "temperature", "hygiene"].map((t) => ({
        value: t,
        label: titleCase(t),
      })),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Quality control"
        description="Completed quality checks, failures and active holds across kitchen stations."
        actions={
          <>
            {can("kitchen", "quality.complete") ? (
              <RecordDialog
                title="Record a quality check"
                description="Completed checks are permanent records and feed the food-safety trail."
                submitLabel="Record check"
                pending={recordCheck.isPending}
                fields={checkFields}
                onSubmit={(values) => recordCheck.mutateAsync(values)}
                trigger={
                  <Button>
                    <Plus className="mr-2 size-4" /> Record check
                  </Button>
                }
              />
            ) : null}
            {can("kitchen", "settings.manage") ? (
              <RecordDialog
                title="New quality checklist"
                description="Checklists define what your team inspects and how often."
                submitLabel="Save checklist"
                pending={saveChecklist.isPending}
                fields={checklistFields}
                onSubmit={(values) => saveChecklist.mutateAsync(values)}
                trigger={<Button variant="outline">New checklist</Button>}
              />
            ) : null}
          </>
        }
      />
      <SectionCard
        title="Completed checks"
        description="Records captured by your kitchen team. Nothing here is simulated."
      >
        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          isEmpty={rows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">No quality checks recorded yet.</p>
          }
        >
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r["id"]} className="flex items-start justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium">{r["quality_checklists"]?.name ?? "Quality check"}</p>
                  <p className="text-xs text-muted-foreground">
                    {`${r["operational_stations"]?.name ?? "Station"} · ${new Date(String(r["created_at"])).toLocaleString()}`}
                  </p>
                </div>
                <StatusPill tone={String(r["result"]) === "failed" ? "destructive" : "success"}>
                  {titleCase(String(r["result"] ?? "recorded"))}
                </StatusPill>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}

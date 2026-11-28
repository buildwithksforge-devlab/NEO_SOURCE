import {usePropertyClock} from '@/lib/use-property-clock';
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { RecordDialog } from "@/components/kitchen/RecordDialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { productionYield, productionCanBeMadeAvailable } from "@/lib/production-yield";
import { titleCase, type Row } from "@/lib/kitchen";
import {
  useKitchenStations,
  usePostProductionBatch,
  useProductionBatches,
  useRecipes,
  useSaveBatch,
} from "@/lib/kitchen-data";

export const Route = createFileRoute("/_shell/kitchen/production")({
  head: () => ({
    meta: [
      { title: "Production batches — NEØ" },
      {
        name: "description",
        content: "Batch and bulk production runs with planned versus produced quantities.",
      },
      { property: "og:title", content: "Production batches — NEØ" },
      {
        property: "og:description",
        content: "Batch and bulk production runs with planned versus produced quantities.",
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
  const query = useProductionBatches();
  const {timeZone} = usePropertyClock();
  const recipes = useRecipes();
  const stations = useKitchenStations();
  const saveBatch = useSaveBatch();
  const postBatch = usePostProductionBatch();
  const canPost = can("kitchen", "production.edit") || can("kitchen", "production.manage");
  const rows = (query.data ?? []) as Row[];

  const fields = [
    {
      name: "recipe_id",
      label: "Recipe",
      type: "select" as const,
      required: true,
      options: (recipes.data ?? []).map((r) => ({
        value: String(r["id"]),
        label: `${r["name"] ?? r["menu_items"]?.name ?? "Recipe"} · v${r["version"] ?? 1}`,
      })),
    },
    {
      name: "station_id",
      label: "Station",
      type: "select" as const,
      options: (stations.data ?? []).map((s) => ({
        value: String(s["id"]),
        label: String(s["name"]),
      })),
    },
    {
      name: "planned_quantity",
      label: "Planned quantity",
      type: "number" as const,
      required: true,
    },
    { name: "actual_quantity", label: "Gross quantity produced", type: "number" as const },
    { name: "unit", label: "Unit", placeholder: "portions, kg, litres" },
    { name: "prepared_at", label: "Prepared at", type: "datetime-local" as const },
    { name: "use_by", label: "Use by", type: "datetime-local" as const },
    { name: "waste_quantity", label: "Waste quantity", type: "number" as const },
    {
      name: "status",
      label: "Status",
      type: "select" as const,
      options: [
        "planned",
        "in-preparation",
        "completed",
        "partially-used",
        "fully-used",
        "discarded",
        "closed",
      ].map((s) => ({
        value: s,
        label: titleCase(s.replace(/-/g, " ")),
      })),
    },
    { name: "notes", label: "Notes", type: "textarea" as const },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Production batches"
        description="Batch and bulk production runs with planned versus produced quantities."
        actions={
          can("kitchen", "production.manage") ? (
            <RecordDialog
              title="New production batch"
              description="Record a bulk preparation run against an approved recipe."
              submitLabel="Save batch"
              pending={saveBatch.isPending || !timeZone}
              timeZone={timeZone}
              fields={fields}
              onSubmit={(values) =>
                saveBatch.mutateAsync({ ...values, status: values["status"] ?? "planned" })
              }
              trigger={
                <Button>
                  <Plus className="mr-2 size-4" /> New batch
                </Button>
              }
            />
          ) : null
        }
      />
      <SectionCard
        title="Production batches"
        description="Records captured by your kitchen team. Nothing here is simulated."
      >
        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          isEmpty={rows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No production batches recorded yet.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const id = String(r["id"]);
              const posted = Boolean(r["posted_at"]);
              const produced = Number(r["actual_quantity"] ?? 0);
              const planned = Number(r["planned_quantity"] ?? 0);
              const waste = Number(r["waste_quantity"] ?? 0);
              const unit = String(r["unit"] ?? "");
              let measurement = null;
              try {
                measurement = productionYield({
                  planned, gross: produced, waste,
                });
              } catch {
                // Historical invalid measurements remain visible.
              }
              const canMakeAvailable = productionCanBeMadeAvailable({
                posted,
                planned,
                gross: produced,
                waste,
                useBy: r["use_by"] ? String(r["use_by"]) : null,
                now: Date.now(),
              });
              return (
                <li
                  key={id}
                  className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{r["batch_number"] ?? "Batch"}</p>
                    {measurement ? (
                      <div className="my-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                        <div>
                          <span className="text-muted-foreground">Gross</span>
                          <p className="font-medium">{measurement.gross.toFixed(3)} {unit}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Waste</span>
                          <p className="font-medium">{measurement.waste.toFixed(3)} {unit}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Usable output</span>
                          <p className="font-medium">{measurement.available.toFixed(3)} {unit}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Yield vs plan</span>
                          <p className="font-medium">{measurement.yieldPercent.toFixed(1)}%</p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-destructive">
                        Production measurements require review.
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {`${r["recipes"]?.menu_items?.name ?? "Item"} · planned ${r["planned_quantity"] ?? 0} · produced ${produced} ${r["unit"] ?? ""}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {posted
                        ? `${r["remaining_quantity"] ?? 0} ${r["unit"] ?? ""} left. Ingredients are deducted when a sale uses the batch.`
                        : produced > 0
                          ? "Ready to make available in the departmental store for this station."
                          : "Record the quantity produced first."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={posted ? "success" : String(r["status"]) === "completed" ? "info" : "default"}>
                      {titleCase(String(r["status"] ?? (posted ? "completed" : "planned")))}
                    </StatusPill>
                    {canPost && canMakeAvailable ? (
                      <Button
                        size="sm"
                        disabled={postBatch.isPending}
                        onClick={() => postBatch.mutate({ batchId: id })}
                      >
                        {postBatch.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                        Make batch available
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}

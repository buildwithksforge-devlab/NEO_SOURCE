import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { RecordDialog } from "@/components/kitchen/RecordDialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { titleCase, type Row } from "@/lib/kitchen";
import { useStockLocations } from "@/lib/inventory-data";
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
  const recipes = useRecipes();
  const stations = useKitchenStations();
  const saveBatch = useSaveBatch();
  const postBatch = usePostProductionBatch();
  const locations = useStockLocations();
  const [store, setStore] = useState<Record<string, string>>({});
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
    { name: "actual_quantity", label: "Actual produced", type: "number" as const },
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
              pending={saveBatch.isPending}
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
              return (
                <li
                  key={id}
                  className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{r["batch_number"] ?? "Batch"}</p>
                    <p className="text-xs text-muted-foreground">
                      {`${r["recipes"]?.menu_items?.name ?? "Item"} · planned ${r["planned_quantity"] ?? 0} · produced ${produced} ${r["unit"] ?? ""}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {posted
                        ? "Posted to stock — ingredients used and the produced item received."
                        : produced > 0
                          ? "Not yet posted to stock."
                          : "Record how much was produced before posting to stock."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={posted ? "success" : String(r["status"]) === "completed" ? "info" : "default"}>
                      {posted ? "Posted to stock" : titleCase(String(r["status"] ?? "planned"))}
                    </StatusPill>
                    {canPost && !posted && produced > 0 ? (
                      <>
                        <Select
                          value={store[id] ?? "station"}
                          onValueChange={(v) => setStore((s) => ({ ...s, [id]: v }))}
                        >
                          <SelectTrigger className="h-9 w-48">
                            <SelectValue placeholder="Station store" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="station">Station store</SelectItem>
                            {(locations.data ?? []).map((l) => (
                              <SelectItem key={String(l["id"])} value={String(l["id"])}>
                                {String(l["name"] ?? "Store")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          disabled={postBatch.isPending}
                          onClick={() =>
                            void postBatch.mutateAsync({
                              batchId: id,
                              locationId: store[id] && store[id] !== "station" ? store[id] : null,
                            })
                          }
                        >
                          {postBatch.isPending ? (
                            <Loader2 className="mr-2 size-4 animate-spin" />
                          ) : null}
                          Post to stock
                        </Button>
                      </>
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

import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { RecordDialog } from "@/components/kitchen/RecordDialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { titleCase, type Row } from "@/lib/kitchen";
import { useStockItemsLite, useStockLocationsLite } from "@/lib/operations-data";
import {
  useKitchenMenuItems,
  useKitchenStations,
  usePostWasteToStock,
  useRecordWaste,
  useReviewWaste,
  useWasteRecords,
} from "@/lib/kitchen-data";

export const Route = createFileRoute("/_shell/kitchen/waste")({
  head: () => ({
    meta: [
      { title: "Waste & spoilage — NEØ" },
      {
        name: "description",
        content: "Every waste record with its category, cost and approval trail.",
      },
      { property: "og:title", content: "Waste & spoilage — NEØ" },
      {
        property: "og:description",
        content: "Every waste record with its category, cost and approval trail.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="waste.view">
      <Page />
    </KitchenGuard>
  ),
});

function Page() {
  const { can } = useAuth();
  const query = useWasteRecords();
  const stations = useKitchenStations();
  const menuItems = useKitchenMenuItems();
  const stockItems = useStockItemsLite();
  const locations = useStockLocationsLite();
  const recordWaste = useRecordWaste();
  const review = useReviewWaste();
  const postToStock = usePostWasteToStock();
  const rows = (query.data ?? []) as Row[];

  const fields = [
    {
      name: "category",
      label: "Category",
      type: "select" as const,
      required: true,
      options: [
        "spoilage",
        "over-production",
        "preparation",
        "customer-return",
        "breakage",
        "expiry",
      ].map((c) => ({
        value: c,
        label: titleCase(c),
      })),
    },
    {
      name: "ingredient_name",
      label: "Ingredient",
      placeholder: "Leave blank for a finished dish",
    },
    {
      name: "menu_item_id",
      label: "Menu item",
      type: "select" as const,
      options: (menuItems.data ?? []).map((m) => ({
        value: String(m["id"]),
        label: String(m["name"]),
      })),
    },
    { name: "quantity", label: "Quantity", type: "number" as const, required: true },
    { name: "unit", label: "Unit", required: true, placeholder: "kg, litres, portions" },
    { name: "estimated_cost", label: "Estimated cost", type: "number" as const },
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
      name: "stock_item_id",
      label: "Stock item to reduce",
      type: "select" as const,
      options: (stockItems.data ?? []).map((s) => ({
        value: String(s["id"]),
        label: String(s["name"]),
      })),
    },
    {
      name: "location_id",
      label: "Store it came from",
      type: "select" as const,
      options: (locations.data ?? []).map((l) => ({
        value: String(l["id"]),
        label: String(l["name"]),
      })),
    },
    { name: "occurred_at", label: "Occurred at", type: "datetime-local" as const },
    { name: "reason", label: "Reason", type: "textarea" as const },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Waste & spoilage"
        description="Every waste record with its category, cost and approval trail."
        actions={
          can("kitchen", "waste.record") ? (
            <RecordDialog
              title="Record waste"
              description="Waste is never deleted. It is recorded, reviewed and reflected in food cost."
              submitLabel="Record waste"
              pending={recordWaste.isPending}
              fields={fields}
              onSubmit={(values) =>
                recordWaste.mutateAsync({
                  ...values,
                  occurred_at: values["occurred_at"] ?? new Date().toISOString(),
                  status: "pending",
                })
              }
              trigger={
                <Button>
                  <Plus className="mr-2 size-4" /> Record waste
                </Button>
              }
            />
          ) : null
        }
      />
      <SectionCard
        title="Waste & spoilage"
        description="Records captured by your kitchen team. Nothing here is simulated."
      >
        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          isEmpty={rows.length === 0}
          empty={<p className="py-6 text-sm text-muted-foreground">No waste recorded yet.</p>}
        >
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r["id"]} className="flex items-start justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium">{`${r["waste_number"] ?? "Waste record"} · ${r["ingredient_name"] ?? r["menu_items"]?.name ?? ""}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {`${titleCase(String(r["category"] ?? ""))} · ${r["quantity"] ?? 0} ${r["unit"] ?? ""} · cost ${r["estimated_cost"] ?? 0}`}
                    {r["posted_at"] ? ` · taken off stock` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill
                    tone={
                      String(r["status"]) === "approved"
                        ? "success"
                        : String(r["status"]) === "rejected"
                          ? "destructive"
                          : "warning"
                    }
                  >
                    {titleCase(String(r["status"] ?? "pending"))}
                  </StatusPill>
                  {r["posted_at"] ? <StatusPill tone="success">Stock reduced</StatusPill> : null}
                  {can("kitchen", "waste.approve") &&
                  String(r["status"] ?? "pending") === "pending" ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ id: String(r["id"]), action: "approved" })}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ id: String(r["id"]), action: "rejected" })}
                      >
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {can("kitchen", "waste.approve") &&
                  String(r["status"] ?? "") === "approved" &&
                  !r["posted_at"] ? (
                    <Button
                      size="sm"
                      disabled={postToStock.isPending}
                      onClick={() => postToStock.mutate({ id: String(r["id"]) })}
                    >
                      {postToStock.isPending ? "Posting…" : "Post to stock"}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}

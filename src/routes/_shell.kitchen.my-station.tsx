import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { Button } from "@/components/ui/button";
import { titleCase } from "@/lib/kitchen";
import { useKitchenItemTransition } from "@/lib/kitchen-tickets";
import { kitchenNum, kitchenStr, useMyKitchenWork, type KitchenRow } from "@/lib/main-kitchen";

export const Route = createFileRoute("/_shell/kitchen/my-station")({
  head: () => ({
    meta: [
      { title: "My Station — Main Kitchen — NEØ" },
      {
        name: "description",
        content:
          "A Hot Kitchen Chef's own assigned items: recipe, portion, modifiers and allergy notes, with preparation status only.",
      },
      { property: "og:title", content: "My Station — Main Kitchen — NEØ" },
      {
        property: "og:description",
        content: "Accept, start and mark ready the Main Kitchen items assigned to you.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="my-station.view">
      <MyStationPage />
    </KitchenGuard>
  ),
});

const NEXT_ITEM_STATUS: Record<string, { to: string; label: string }> = {
  new: { to: "accepted", label: "Accept" },
  accepted: { to: "preparing", label: "Start preparing" },
  preparing: { to: "ready", label: "Mark ready" },
};

function MyStationPage() {
  const work = useMyKitchenWork();
  const transition = useKitchenItemTransition();
  const rows = (work.data ?? []) as KitchenRow[];

  const preparing = rows.filter((r) => String(r["item_status"]) === "preparing").length;
  const ready = rows.filter((r) => String(r["item_status"]) === "ready").length;

  return (
    <div>
      <PageHeader
        eyebrow="Main Kitchen"
        title="My station"
        description="Only the items assigned to you. Prepare to recipe and portion, follow the special instructions, then mark ready — the bill is never part of your screen."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="Assigned to me">
          <p className="text-3xl font-semibold">{rows.length}</p>
        </SectionCard>
        <SectionCard title="In preparation">
          <p className="text-3xl font-semibold">{preparing}</p>
        </SectionCard>
        <SectionCard title="Ready for service">
          <p className="text-3xl font-semibold">{ready}</p>
        </SectionCard>
      </div>

      <SectionCard title="My items" description="Newest orders last — work the oldest first.">
        <QueryState
          isLoading={work.isLoading}
          error={work.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="Nothing assigned to you"
              description="When the Hot Kitchen Supervisor assigns you an item, it appears here with the recipe, portion and any allergy note."
            />
          }
        >
          <div className="space-y-3">
            {rows.map((r) => {
              const status = String(r["item_status"] ?? "new");
              const next = NEXT_ITEM_STATUS[status];
              const allergy = kitchenStr(r["allergy_alert"], "");
              return (
                <div key={String(r["item_id"])} className="rounded-xl border border-border p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-medium">
                        {kitchenStr(r["menu_item"])} × {kitchenNum(r["quantity"]) || 1}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {kitchenStr(r["ticket_number"])} · {kitchenStr(r["table_code"], "No table")}{" "}
                        · {titleCase(kitchenStr(r["order_type"], "dine-in"))} ·{" "}
                        {kitchenNum(r["age_minutes"])}m in kitchen
                      </p>
                      {kitchenStr(r["modifiers"], "") !== "—" &&
                      kitchenStr(r["modifiers"], "") !== "" ? (
                        <p className="mt-1 text-sm">Modifiers: {kitchenStr(r["modifiers"])}</p>
                      ) : null}
                      {kitchenStr(r["special_instructions"], "") !== "—" &&
                      kitchenStr(r["special_instructions"], "") !== "" ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          Instructions: {kitchenStr(r["special_instructions"])}
                        </p>
                      ) : null}
                      {allergy !== "—" && allergy !== "" ? (
                        <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium">
                          Allergy alert: {allergy}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill
                        tone={
                          status === "ready"
                            ? "success"
                            : status === "preparing"
                              ? "warning"
                              : "default"
                        }
                      >
                        {titleCase(status)}
                      </StatusPill>
                      {next ? (
                        <Button
                          size="sm"
                          disabled={transition.isPending}
                          onClick={() =>
                            transition.mutate({ itemId: String(r["item_id"]), to: next.to })
                          }
                        >
                          {next.label}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

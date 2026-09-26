import { createFileRoute, Link } from "@tanstack/react-router";
import { CakeSlice, ClipboardList, PackageSearch, Trash2 } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  EmptyState,
  PastryGuard,
  PastryStatusBadge,
  QueryState,
} from "@/components/pastry/PastryShared";
import { Button } from "@/components/ui/button";
import {
  pastryNum,
  pastryStr,
  useCustomCakeOrders,
  usePastryProductionItems,
  usePastryStockNeeds,
  usePastryWaste,
  type PastryRow,
} from "@/lib/pastry-department";

export const Route = createFileRoute("/_shell/pastry/")({
  head: () => ({
    meta: [
      { title: "Pastry & Bakery — NEØ" },
      {
        name: "description",
        content:
          "Pastry and bakery production at a glance: today's planned output, custom cake orders due, reported stock needs and wastage awaiting review.",
      },
      { property: "og:title", content: "Pastry & Bakery — NEØ" },
      {
        property: "og:description",
        content: "Planned bakery production, custom cakes and wastage in one department view.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PastryGuard feature="pastry-production">
      <PastryHome />
    </PastryGuard>
  ),
});

function PastryHome() {
  const items = usePastryProductionItems();
  const cakes = useCustomCakeOrders();
  const needs = usePastryStockNeeds();
  const waste = usePastryWaste();

  const rows = (items.data ?? []) as PastryRow[];
  const open = rows.filter((r) => !["completed", "cancelled"].includes(String(r["status"])));
  const planned = rows.reduce((sum, r) => sum + pastryNum(r["quantity"]), 0);
  const produced = rows.reduce((sum, r) => sum + pastryNum(r["produced_quantity"]), 0);
  const cakeRows = (cakes.data ?? []) as PastryRow[];
  const openCakes = cakeRows.filter(
    (r) => !["collected", "cancelled"].includes(String(r["status"])),
  );
  const openNeeds = ((needs.data ?? []) as PastryRow[]).filter((r) =>
    ["reported", "acknowledged"].includes(String(r["status"])),
  );
  const pendingWaste = ((waste.data ?? []) as PastryRow[]).filter(
    (r) => String(r["status"]) === "pending-review",
  );

  return (
    <div>
      <PageHeader
        eyebrow="Kitchen"
        title="Pastry & Bakery"
        description="Production is planned before the order arrives. Plan the day, assign your Pastry Chefs, keep custom cakes on time and account for every tray that does not sell."
        actions={
          <Button asChild>
            <Link to="/pastry/production">Open production plan</Link>
          </Button>
        }
      />

      <div className="neo-kpi-grid mb-6">
        <StatCard
          lead
          label="Open production"
          value={String(open.length)}
          hint={`${produced.toFixed(0)} of ${planned.toFixed(0)} produced`}
          icon={ClipboardList}
        />
        <StatCard
          label="Custom cakes in hand"
          value={String(openCakes.length)}
          icon={CakeSlice}
          tone="accent"
        />
        <StatCard
          label="Stock needs open"
          value={String(openNeeds.length)}
          icon={PackageSearch}
          tone="warning"
        />
        <StatCard
          label="Wastage to review"
          value={String(pendingWaste.length)}
          icon={Trash2}
          tone="warning"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Production in progress"
          description="Everything planned for the current schedule that is not yet finished."
        >
          <QueryState
            isLoading={items.isLoading}
            error={items.error}
            isEmpty={open.length === 0}
            empty={
              <EmptyState
                title="Nothing in production"
                description="Create a production plan and add the products for the day."
              />
            }
          >
            <ul className="space-y-2">
              {open.slice(0, 8).map((r) => (
                <li
                  key={String(r["id"])}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium">{pastryStr(r["product"])}</p>
                    <p className="text-xs text-muted-foreground">
                      {pastryNum(r["quantity"])} {pastryStr(r["unit"], "piece")}
                    </p>
                  </div>
                  <PastryStatusBadge status={String(r["status"])} />
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Custom cakes due"
          description="Ordered ahead, with a name, a message and a deadline."
        >
          <QueryState
            isLoading={cakes.isLoading}
            error={cakes.error}
            isEmpty={openCakes.length === 0}
            empty={
              <EmptyState
                title="No custom cakes"
                description="Custom cake orders you take will appear here."
              />
            }
          >
            <ul className="space-y-2">
              {openCakes.slice(0, 8).map((r) => (
                <li
                  key={String(r["id"])}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium">{pastryStr(r["product"])}</p>
                    <p className="text-xs text-muted-foreground">
                      {pastryStr(r["order_number"])} ·{" "}
                      {r["required_at"]
                        ? new Date(String(r["required_at"])).toLocaleString()
                        : "No deadline"}
                    </p>
                  </div>
                  <PastryStatusBadge status={String(r["status"])} />
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>
      </div>
    </div>
  );
}

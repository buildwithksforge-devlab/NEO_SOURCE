import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { useKitchenRealtime } from "@/lib/kitchen-data";

export const Route = createFileRoute("/_shell/kitchen")({
  component: KitchenLayout,
});

const TABS = [
  { label: "Kitchen Home", to: "/kitchen" },
  { label: "Dashboard", to: "/kitchen/dashboard" },
  { label: "Live Queue", to: "/kitchen/queue" },
  { label: "My Station", to: "/kitchen/my-station" },
  { label: "Station Stock", to: "/station-stock" },
  { label: "Stewarding", to: "/kitchen/stewarding" },
  { label: "Stock Needs", to: "/kitchen/needs" },
  { label: "Reorder", to: "/kitchen/reorder" },
  { label: "Stock Count", to: "/kitchen/stock-count" },
  { label: "Operations", to: "/kitchen/operations" },
  { label: "Reconciliation", to: "/kitchen/reconciliation" },
  { label: "Recipes", to: "/kitchen/recipes" },
  { label: "Production", to: "/kitchen/production" },
  { label: "Stores & Shortages", to: "/kitchen/stores" },
  { label: "Waste", to: "/kitchen/waste" },
  { label: "Quality", to: "/kitchen/quality" },
  { label: "Reports", to: "/kitchen/reports" },
  { label: "Settings", to: "/kitchen/settings" },
];

function KitchenLayout() {
  useKitchenRealtime();

  return (
    <div>
      <SectionTabs tabs={TABS} rootPath="/kitchen" />
      <Outlet />
    </div>
  );
}

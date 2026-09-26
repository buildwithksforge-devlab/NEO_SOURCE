import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";

export const Route = createFileRoute("/_shell/pastry")({
  component: PastryLayout,
});

const TABS = [
  { label: "Pastry Home", to: "/pastry" },
  { label: "Order Queue", to: "/pastry/queue" },
  { label: "Production Plan", to: "/pastry/production" },
  { label: "My Production", to: "/pastry/my-production" },
  { label: "Custom Cakes", to: "/pastry/custom-cakes" },
  { label: "Wastage", to: "/pastry/wastage" },
  { label: "Stock Needs", to: "/pastry/needs" },
  { label: "Station Stock", to: "/station-stock" },
  { label: "Requisitions", to: "/pastry/requisitions" },
];

function PastryLayout() {
  return (
    <div>
      <SectionTabs tabs={TABS} rootPath="/pastry" />
      <Outlet />
    </div>
  );
}

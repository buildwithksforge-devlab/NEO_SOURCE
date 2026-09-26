import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/inventory")({
  component: InventoryLayout,
});

const TABS = [
  { label: "Dashboard", to: "/inventory", module: "stores", feature: "overview" },
  {
    label: "Department Requests",
    to: "/inventory/requisitions",
    module: "stores",
    feature: "requisitions",
  },
  { label: "Store Issues", to: "/inventory/issues", module: "stores", feature: "issues" },
  { label: "Store Transfers", to: "/inventory/transfers", module: "stores", feature: "issues" },
  { label: "Stock Needs", to: "/inventory/needs", module: "stores", feature: "requisitions" },
  {
    label: "Goods Receiving",
    to: "/inventory/receiving",
    module: "procurement",
    feature: "receiving",
  },
  { label: "Counts & Variances", to: "/inventory/counts", module: "stores", feature: "counts" },
  { label: "Stores Tasks", to: "/inventory/tasks", module: "stores", feature: "tasks" },
] as const;

function InventoryLayout() {
  const { can } = useAuth();

  // A Receiving Clerk only ever sees receiving work; a Storekeeper sees the
  // whole department. The tab bar follows the permission, not the job title.
  const tabs = TABS.filter((tab) => can(tab.module, `${tab.feature}.view`));

  return (
    <div>
      {tabs.length > 1 ? <SectionTabs tabs={tabs} rootPath="/inventory" /> : null}
      <Outlet />
    </div>
  );
}

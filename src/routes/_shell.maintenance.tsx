import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { Building2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useBranchScope } from "@/lib/branches";

export const Route = createFileRoute("/_shell/maintenance")({
  component: MaintenanceLayout,
});

/**
 * Tabs are driven by the capability registry — one `maintenance.<feature>.view`
 * per screen — so a tab is never offered for a page the route guard refuses.
 */
const TABS: { label: string; to: string; feature: string; action: string }[] = [
  { label: "Work Orders", to: "/maintenance", feature: "overview", action: "view" },
  { label: "My Jobs", to: "/maintenance/my-jobs", feature: "my-jobs", action: "view" },
  { label: "Grounds Board", to: "/maintenance/grounds", feature: "grounds", action: "view" },
  { label: "My Grounds Tasks", to: "/maintenance/my-tasks", feature: "my-tasks", action: "view" },
  { label: "Landscaping", to: "/maintenance/landscaping", feature: "landscaping", action: "view" },
  { label: "Materials", to: "/maintenance/supplies", feature: "supplies", action: "view" },
];

function MaintenanceLayout() {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const { branches } = useBranchScope();
  const tabs = TABS.filter((t) => can("maintenance", t.feature, t.action));
  const propertyName = branchId
    ? (branches.find((b) => b.id === branchId)?.name ?? "Selected property")
    : "All properties";

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Building2 className="size-3.5" />
        <span>
          Maintenance &amp; landscaping for{" "}
          <span className="font-medium text-foreground">{propertyName}</span>
        </span>
      </div>
      {tabs.length > 1 ? <SectionTabs tabs={tabs} rootPath="/maintenance" /> : null}
      <Outlet />
    </div>
  );
}

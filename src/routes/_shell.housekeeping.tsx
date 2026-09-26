import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { useAuth } from "@/lib/auth";
import { useOperationsRealtime } from "@/lib/operations-data";

export const Route = createFileRoute("/_shell/housekeeping")({
  head: () => ({
    meta: [
      { title: "Housekeeping Operations — HOS" },
      {
        name: "description",
        content:
          "Live room board, cleaning tasks, inspections, deep cleaning and Lost & Found for your property.",
      },
      { property: "og:title", content: "Housekeeping Operations — HOS" },
      {
        property: "og:description",
        content:
          "Live room board, cleaning tasks, inspections, deep cleaning and Lost & Found for your property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: HousekeepingLayout,
});

const TABS = [
  { label: "Dashboard", to: "/housekeeping", feature: "overview" },
  { label: "My Work", to: "/housekeeping/my-work", feature: "my-work" },
  { label: "Room Board", to: "/housekeeping/board", feature: "board" },
  { label: "Cleaning Tasks", to: "/housekeeping/tasks", feature: "tasks" },
  { label: "Inspections", to: "/housekeeping/inspections", feature: "inspections" },
  { label: "Supplies", to: "/housekeeping/supplies", feature: "supplies" },
  { label: "Requisitions", to: "/housekeeping/requisitions", feature: "requisitions" },
  { label: "Lost & Found", to: "/housekeeping/lost-found", feature: "lost-found" },
  { label: "Reports", to: "/housekeeping/reports", feature: "reports" },
] as const;

function HousekeepingLayout() {
  const { can } = useAuth();
  useOperationsRealtime();

  // Each tab is shown only to someone who actually holds that screen's
  // permission, so a housekeeper never sees the whole-property views.
  const tabs = TABS.filter((tab) => can("housekeeping", `${tab.feature}.view`));

  return (
    <div>
      <SectionTabs tabs={tabs} rootPath="/housekeeping" />
      <Outlet />
    </div>
  );
}

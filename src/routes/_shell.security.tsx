import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";

export const Route = createFileRoute("/_shell/security")({
  component: SecurityLayout,
});

const TABS = [
  { label: "Security Home", to: "/security" },
  { label: "My Post", to: "/security/my-post" },
  { label: "Incidents", to: "/security/incidents" },
  { label: "Posts & Guards", to: "/security/posts" },
  { label: "Patrols", to: "/security/patrols" },
  { label: "Visitor Access", to: "/security/visitors" },
  { label: "Handovers", to: "/security/handovers" },
  { label: "Stock Needs", to: "/security/needs" },
];

function SecurityLayout() {
  return (
    <div>
      <SectionTabs tabs={TABS} rootPath="/security" />
      <Outlet />
    </div>
  );
}

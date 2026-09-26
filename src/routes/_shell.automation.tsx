import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { useAuth } from "@/lib/auth";
import { pathPermitted } from "@/lib/capabilities";

export const Route = createFileRoute("/_shell/automation")({
  component: AutomationLayout,
});

const TABS = [
  { label: "Dashboard", to: "/automation" },
  { label: "Workflows", to: "/automation/workflows" },
  { label: "Message Templates", to: "/automation/templates" },
  { label: "Communication Queue", to: "/automation/queue" },
  { label: "Event Log", to: "/automation/events" },
  { label: "Rules & Escalations", to: "/automation/rules" },
  { label: "Failed Workflows", to: "/automation/failures" },
  { label: "Providers", to: "/automation/providers" },
  { label: "Settings", to: "/automation/settings" },
];

function AutomationLayout() {
  const { can, loading } = useAuth();
  // Never advertise an automation screen the signed-in member cannot open.
  const tabs = loading ? TABS : TABS.filter((t) => pathPermitted(can, t.to));
  return (
    <div>
      <SectionTabs tabs={tabs} rootPath="/automation" />
      <Outlet />
    </div>
  );
}

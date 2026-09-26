import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { useAuth } from "@/lib/auth";
import { pathPermitted } from "@/lib/capabilities";

export const Route = createFileRoute("/_shell/marketing")({
  component: MarketingLayout,
});

const TABS = [
  { label: "Dashboard", to: "/marketing" },
  { label: "Content", to: "/marketing/content" },
  { label: "Leads", to: "/marketing/leads" },
  { label: "Pipeline", to: "/marketing/pipeline" },
  { label: "Segments", to: "/marketing/segments" },
  { label: "Campaigns", to: "/marketing/campaigns" },
  { label: "Calendar", to: "/marketing/calendar" },
  { label: "Automations", to: "/marketing/automations" },
  { label: "Templates", to: "/marketing/templates" },
  { label: "Promotions", to: "/marketing/promotions" },
  { label: "Referrals", to: "/marketing/referrals" },
  { label: "Reputation", to: "/marketing/reviews" },
  { label: "Recovery", to: "/marketing/recovery" },
  { label: "Feedback", to: "/marketing/feedback" },
  { label: "Consent", to: "/marketing/consent" },
  { label: "Suppression", to: "/marketing/suppression" },
  { label: "Tasks", to: "/marketing/tasks" },
  { label: "Supplies", to: "/marketing/supplies" },
  { label: "Reports", to: "/marketing/reports" },
  { label: "Settings", to: "/marketing/settings" },
];

function MarketingLayout() {
  // The tab bar must never offer a view the guard would then deny.
  const { can, loading } = useAuth();
  const tabs = loading ? [] : TABS.filter((tab) => pathPermitted(can, tab.to));
  return (
    <div>
      <SectionTabs tabs={tabs} rootPath="/marketing" />
      <Outlet />
    </div>
  );
}

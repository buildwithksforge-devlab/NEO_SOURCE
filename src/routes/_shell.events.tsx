import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { Building2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useEventsCtx } from "@/lib/events-data";
import { useBranchScope } from "@/lib/branches";

export const Route = createFileRoute("/_shell/events")({
  component: EventsLayout,
});

/**
 * Tabs are driven by the canonical capability registry — one
 * `events.<feature>.<action>` per screen — so a tab can never be offered for a
 * page the route guard would refuse.
 */
const TABS: { label: string; to: string; feature: string; action: string }[] = [
  { label: "Dashboard", to: "/events", feature: "overview", action: "view" },
  { label: "Enquiries", to: "/events/enquiries", feature: "enquiries", action: "view" },
  { label: "Calendar", to: "/events/calendar", feature: "calendar", action: "view" },
  { label: "Site Visits", to: "/events/site-visits", feature: "site-visits", action: "view" },
  { label: "Quotations", to: "/events/quotations", feature: "quotations", action: "view" },
  { label: "Bookings", to: "/events/bookings", feature: "bookings", action: "view" },
  { label: "Department Readiness", to: "/events/readiness", feature: "readiness", action: "view" },
  { label: "Banqueting", to: "/events/banqueting", feature: "banqueting", action: "view" },
  { label: "My Tasks", to: "/events/my-tasks", feature: "my_tasks", action: "view" },
  { label: "Supplies", to: "/events/supplies", feature: "stock_needs", action: "view" },
  { label: "Venues", to: "/events/venues", feature: "venues", action: "view" },
  { label: "Packages", to: "/events/packages", feature: "packages", action: "view" },
  { label: "Equipment", to: "/events/resources", feature: "resources", action: "view" },
  { label: "Billing", to: "/events/billing", feature: "billing", action: "view" },
  { label: "Feedback", to: "/events/feedback", feature: "feedback", action: "view" },
  { label: "Reports", to: "/events/reports", feature: "reports", action: "view" },
  { label: "Settings", to: "/events/settings", feature: "settings", action: "edit" },
];

function EventsLayout() {
  const { can } = useAuth();
  const { branchId } = useEventsCtx();
  const { branches } = useBranchScope();
  const tabs = TABS.filter((t) => can("events", t.feature, t.action));
  const propertyName = branchId
    ? (branches.find((b) => b.id === branchId)?.name ?? "Selected property")
    : "All properties";

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Building2 className="size-3.5" />
        <span>
          Events shown for <span className="font-medium text-foreground">{propertyName}</span>
          {!branchId ? " — choose a single property to create or edit records" : ""}
        </span>
      </div>
      <SectionTabs tabs={tabs} rootPath="/events" />
      <Outlet />
    </div>
  );
}

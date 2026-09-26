import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { useAuth } from "@/lib/auth";
import { useOperationsRealtime } from "@/lib/operations-data";

export const Route = createFileRoute("/_shell/laundry")({
  head: () => ({
    meta: [
      { title: "Laundry Department — NEØ Hospitality OS" },
      {
        name: "description",
        content:
          "Guest laundry, linen batch processing, damage and loss control and laundry supply needs for your property.",
      },
      { property: "og:title", content: "Laundry Department — NEØ Hospitality OS" },
      {
        property: "og:description",
        content:
          "Linen handovers, the wash conveyor, attendant work and linen accountability in one department console.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LaundryLayout,
});

const TABS = [
  { label: "Guest Laundry", to: "/laundry", feature: "guest" },
  { label: "My Work", to: "/laundry/my-work", feature: "my-work" },
  { label: "Linen Batches", to: "/laundry/batches", feature: "batches" },
  { label: "Damage & Loss", to: "/laundry/incidents", feature: "incidents" },
  { label: "Supplies", to: "/laundry/supplies", feature: "supplies" },
] as const;

function LaundryLayout() {
  const { can } = useAuth();
  useOperationsRealtime();

  // Each tab is shown only to someone holding that screen's permission, so an
  // attendant never sees the whole-department views.
  const tabs = TABS.filter((tab) => can("laundry", `${tab.feature}.view`));

  return (
    <div>
      {tabs.length > 1 ? <SectionTabs tabs={tabs} rootPath="/laundry" /> : null}
      <Outlet />
    </div>
  );
}

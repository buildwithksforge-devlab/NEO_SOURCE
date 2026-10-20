import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";

export const Route = createFileRoute("/_shell/procurement")({
  head: () => ({
    meta: [
      { title: "Procurement — NEØ" },
      {
        name: "description",
        content:
          "Sourcing, supplier quotations, purchase orders and delivery follow-up, with receiving and payment kept separate.",
      },
      { property: "og:title", content: "Procurement — NEØ" },
      {
        property: "og:description",
        content:
          "Compare quotations, raise orders and chase deliveries. Procurement never receives its own goods.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ProcurementLayout,
});

const TABS = [
  { label: "Dashboard", to: "/procurement" },
  { label: "Requests", to: "/procurement/requests" },
  { label: "Quotations", to: "/procurement/quotations" },
  { label: "Order Tracking", to: "/procurement/orders" },
  { label: "Receiving Reconciliation", to: "/procurement/reconciliation" },
  { label: "Tasks", to: "/procurement/tasks" },
  { label: "Office Supplies", to: "/procurement/supplies" },
];

function ProcurementLayout() {
  return (
    <div>
      <SectionTabs tabs={TABS} rootPath="/procurement" />
      <Outlet />
    </div>
  );
}

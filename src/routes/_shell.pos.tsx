import { useMemo } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { usePosRealtime } from "@/lib/pos-data";
import { useAuth } from "@/lib/auth";
import { canAccessPath } from "@/lib/nav-permissions";

export const Route = createFileRoute("/_shell/pos")({
  component: PosLayout,
});

const TABS = [
  { label: "POS Home", to: "/pos" },
  { label: "Restaurant Floor", to: "/pos/floor" },
  { label: "Orders & Bills", to: "/pos/orders" },
  { label: "Kitchen Display", to: "/pos/kds" },
  { label: "Menu Management", to: "/pos/menu" },
  { label: "Shift & Cash", to: "/pos/shifts" },
  { label: "Requisitions", to: "/pos/requisitions" },
  { label: "Wastage", to: "/pos/wastage" },
  { label: "Approvals", to: "/pos/approvals" },
  { label: "Reports", to: "/pos/reports" },
  { label: "Settings", to: "/pos/settings" },
];

function PosLayout() {
  usePosRealtime();
  // The tab strip resolves through exactly the same capability registry as the
  // sidebar and the route guard, so a tab is never offered for a screen the
  // user would be refused.
  const { can, loading } = useAuth();
  const tabs = useMemo(
    () => (loading ? [] : TABS.filter((t) => canAccessPath(can, t.to))),
    [can, loading],
  );

  return (
    <div>
      <SectionTabs tabs={tabs} rootPath="/pos" />
      <Outlet />
    </div>
  );
}

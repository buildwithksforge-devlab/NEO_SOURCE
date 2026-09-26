import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { useAuth } from "@/lib/auth";
import { pathPermitted } from "@/lib/capabilities";

export const Route = createFileRoute("/_shell/hr")({
  head: () => ({
    meta: [
      { title: "Human Resources & Workforce — HOS" },
      {
        name: "description",
        content:
          "Employee records, recruitment, attendance, rosters, leave, performance, training and payroll preparation for your property.",
      },
      { property: "og:title", content: "Human Resources & Workforce — HOS" },
      {
        property: "og:description",
        content:
          "Employee records, recruitment, attendance, rosters, leave, performance, training and payroll preparation for your property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: HrLayout,
});

const TABS = [
  { label: "Dashboard", to: "/hr" },
  { label: "Employees", to: "/hr/employees" },
  { label: "Onboarding", to: "/hr/onboarding" },
  { label: "Recruitment", to: "/hr/recruitment" },
  { label: "Documents", to: "/hr/documents" },
  { label: "Movements", to: "/hr/movements" },
  { label: "Relations", to: "/hr/relations" },
  { label: "Attendance", to: "/hr/attendance" },
  { label: "Time Clock", to: "/hr/clock" },
  { label: "Scheduling", to: "/hr/scheduling" },
  { label: "Leave", to: "/hr/leave" },
  { label: "Performance", to: "/hr/performance" },
  { label: "Training", to: "/hr/training" },
  { label: "Payroll", to: "/hr/payroll" },
  { label: "Payslips", to: "/hr/payslips" },
  { label: "My HR", to: "/hr/me" },
  { label: "Supplies", to: "/hr/supplies" },
  { label: "Settings", to: "/hr/settings" },
];

function HrLayout() {
  const { can, loading } = useAuth();
  // Never advertise a workforce screen the signed-in member cannot open.
  const tabs = loading ? TABS : TABS.filter((t) => pathPermitted(can, t.to));
  return (
    <div>
      <SectionTabs tabs={tabs} rootPath="/hr" />
      <Outlet />
    </div>
  );
}

import { Outlet, createFileRoute } from "@tanstack/react-router";
import {
  BookOpen,
  Database,
  FlaskConical,
  Flag,
  Activity,
  CreditCard,
  Plug,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { SectionTabs, type SectionTab } from "@/components/common/SectionTabs";
import { AccessDenied } from "@/components/platform/PlatformShared";
import { useAuth } from "@/lib/auth";
import { canAccessPath } from "@/lib/nav-permissions";

export const Route = createFileRoute("/_shell/platform")({
  head: () => ({
    meta: [
      { title: "Platform Readiness & Integrations — HOS" },
      {
        name: "description",
        content:
          "Integration centre, environments, subscription, data migration, testing and go-live readiness for the hospitality platform.",
      },
      { property: "og:title", content: "Platform Readiness & Integrations — HOS" },
      {
        property: "og:description",
        content:
          "Verified integration statuses, environment separation, migration control and go-live readiness gates.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PlatformLayout,
});

const TABS: readonly SectionTab[] = [
  { to: "/platform", label: "Go-Live Readiness", icon: ShieldCheck },
  { to: "/platform/integrations", label: "Integration Centre", icon: Plug },
  { to: "/platform/environments", label: "Environments & Flags", icon: Flag },
  { to: "/platform/subscription", label: "Subscription", icon: CreditCard },
  { to: "/platform/printers", label: "Printers", icon: Plug },
  { to: "/platform/migration", label: "Data Migration", icon: Database },
  { to: "/platform/data-lifecycle", label: "History & Tenant Migration", icon: Database },
  { to: "/platform/recovery", label: "Recovery Centre", icon: ShieldCheck },
  { to: "/platform/configuration-health", label: "Configuration Health", icon: ShieldCheck },
  { to: "/platform/quality", label: "Testing & Defects", icon: FlaskConical },
  { to: "/platform/simulation", label: "Simulation Centre", icon: FlaskConical },
  { to: "/platform/operations", label: "Releases & Monitoring", icon: Activity },
  { to: "/platform/support", label: "Support & Knowledge", icon: BookOpen },
];

function PlatformLayout() {
  const { can } = useAuth();

  const visible = TABS.filter((t) => canAccessPath(can, t.to));
  const anyAccess = visible.length > 0;

  if (!anyAccess) {
    return (
      <div className="p-6">
        <AccessDenied
          title="Platform readiness is not enabled for your role"
          body="These screens control integrations, environments, migrations and go-live approval. Ask an administrator to grant the relevant module to your role."
        />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Platform"
        title="Readiness, Integrations & Commercial Operations"
        description="Nothing on these screens simulates a provider. An integration is only shown as connected once credentials, sandbox testing, security review and production approval are all recorded."
      />
      <SectionTabs tabs={visible} rootPath="/platform" maxVisible={10} />
      <Outlet />
    </div>
  );
}

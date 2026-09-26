import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Compass, LayoutDashboard } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { capabilityForPath } from "@/lib/capabilities";
import { dashboardSpec, type Widget } from "@/lib/dashboards";
import { navigation } from "@/lib/navigation";
import { canAccessPath, navItemVisible, type CanFn } from "@/lib/nav-permissions";
import { canFromPermissions } from "@/lib/permissions";
import { dashboardKeyForRole } from "@/lib/workspace-preview";
import { useOrgRoles, useRolePermissions } from "@/lib/workspace-preview-data";

export const Route = createFileRoute("/admin/capability-map")({
  head: () => ({
    meta: [
      { title: "Capability Map — HOS Administration" },
      {
        name: "description",
        content:
          "Developer diagnostics: the exact capability behind every navigation item and dashboard widget, resolved against a selected role.",
      },
      { property: "og:title", content: "Capability Map — HOS Administration" },
      {
        property: "og:description",
        content:
          "Read-only diagnostics showing which permission gates each sidebar entry and dashboard widget for a chosen role.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CapabilityMapPage,
});

const capLabel = (path: string) => {
  const c = capabilityForPath(path);
  return c ? `${c.module}.${c.feature}.${c.action}` : "universal (no gate)";
};

const requireLabel = (r?: { module: string; feature: string; action: string }) =>
  r ? `${r.module}.${r.feature}.${r.action}` : "ungated";

function Verdict({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <StatusPill tone={ok ? "success" : "default"}>{ok ? yes : no}</StatusPill>;
}

function CapabilityMapPage() {
  const { can: myCan } = useAuth();
  const mayDiagnose = myCan("administration", "roles", "edit");

  const roles = useOrgRoles(mayDiagnose);
  const [roleId, setRoleId] = useState<string | null>(null);
  const permissions = useRolePermissions(mayDiagnose ? roleId : null);

  const role = (roles.data ?? []).find((r) => r.id === roleId) ?? null;
  const can: CanFn = useMemo(
    () => canFromPermissions(permissions.data ?? new Set<string>()),
    [permissions.data],
  );

  const spec = dashboardSpec(role ? dashboardKeyForRole(role.name) : null);
  const permitted = (r?: { module: string; feature: string; action: string }) =>
    !r || can(r.module, r.feature, r.action);

  if (!mayDiagnose) {
    return (
      <div>
        <PageHeader
          eyebrow="Administration"
          title="Capability map"
          description="This diagnostics view is limited to administrators who manage roles."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Administration · Diagnostics"
        title="Capability map"
        description="Every sidebar entry and dashboard widget with the exact capability that gates it, resolved live against one role. Read-only: nothing here grants or removes access."
        actions={
          <Link to="/admin" className="inline-flex items-center text-sm text-muted-foreground">
            <ArrowLeft className="mr-2 h-4 w-4" /> Administration
          </Link>
        }
      />

      <div className="mt-4 max-w-sm">
        <Select value={roleId ?? ""} onValueChange={(v) => setRoleId(v)}>
          <SelectTrigger aria-label="Role to diagnose">
            <SelectValue placeholder="Select a role" />
          </SelectTrigger>
          <SelectContent>
            {(roles.data ?? []).map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-6 space-y-6">
        <SectionCard
          title="Navigation items"
          description="Capability required by the route, plus whether the primary-sidebar surface gate keeps it in this role's workspace."
        >
          {!roleId ? (
            <p className="text-sm text-muted-foreground">
              Select a role to resolve every navigation gate.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2">Item</th>
                    <th className="py-2">Path</th>
                    <th className="py-2">Capability</th>
                    <th className="py-2">Route access</th>
                    <th className="py-2">In sidebar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {navigation.flatMap((group) =>
                    group.items.map((item) => (
                      <tr key={`${group.title}-${item.to}`}>
                        <td className="py-2">
                          <span className="inline-flex items-center gap-2">
                            <Compass className="h-3.5 w-3.5 text-muted-foreground" />
                            {item.label}
                          </span>
                          <span className="block text-xs text-muted-foreground">{group.title}</span>
                        </td>
                        <td className="py-2 font-mono text-xs">{item.to}</td>
                        <td className="py-2 font-mono text-xs">{capLabel(item.to)}</td>
                        <td className="py-2">
                          <Verdict ok={canAccessPath(can, item.to)} yes="Allowed" no="Denied" />
                        </td>
                        <td className="py-2">
                          <Verdict ok={navItemVisible(can, item.to)} yes="Shown" no="Hidden" />
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title={`Dashboard widgets — ${spec.name}`}
          description="Widgets and quick actions omit themselves when the role lacks the named capability."
        >
          {!roleId ? (
            <p className="text-sm text-muted-foreground">Select a role to resolve widget gates.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2">Surface</th>
                    <th className="py-2">Identifier</th>
                    <th className="py-2">Capability</th>
                    <th className="py-2">Rendered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {spec.widgets.map((w: Widget) => (
                    <tr key={`widget-${w.id}`}>
                      <td className="py-2">
                        <span className="inline-flex items-center gap-2">
                          <LayoutDashboard className="h-3.5 w-3.5 text-muted-foreground" />
                          {w.title}
                        </span>
                      </td>
                      <td className="py-2 font-mono text-xs">{w.id}</td>
                      <td className="py-2 font-mono text-xs">{requireLabel(w.requires)}</td>
                      <td className="py-2">
                        <Verdict ok={permitted(w.requires)} yes="Rendered" no="Omitted" />
                      </td>
                    </tr>
                  ))}
                  {spec.quickActions.map((a) => (
                    <tr key={`action-${a.label}-${a.to}`}>
                      <td className="py-2">{a.label}</td>
                      <td className="py-2 font-mono text-xs">{a.to}</td>
                      <td className="py-2 font-mono text-xs">{requireLabel(a.requires)}</td>
                      <td className="py-2">
                        <Verdict ok={permitted(a.requires)} yes="Rendered" no="Omitted" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

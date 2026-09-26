import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { roleLabels, type Role } from "@/lib/navigation";
import { useTenant } from "@/lib/tenant";

export const Route = createFileRoute("/admin/user-defaults")({
  head: () => ({
    meta: [
      { title: "User Defaults — System Administration" },
      {
        name: "description",
        content:
          "Preview the roles available in the Hospitality Operating System and the default workspace preferences applied to new staff accounts.",
      },
      { property: "og:title", content: "User Defaults — System Administration" },
      { property: "og:description", content: "Roles and default preferences for new staff accounts." },
    ],
  }),
  component: UserDefaultsPage,
});

/** Declared reach per template — never inferred from the role's name. */
const roleReach: Record<Role, "organisation" | "scoped"> = {
  owner: "organisation",
  manager: "scoped",
  "front-office": "scoped",
  waiter: "scoped",
  kitchen: "scoped",
  housekeeping: "scoped",
  maintenance: "scoped",
  store: "scoped",
  accountant: "scoped",
  marketing: "scoped",
  hr: "scoped",
};

const roleScope: Record<Role, string> = {
  owner: "Full access to every module and all branches",
  manager: "Operational access across the assigned property",
  "front-office": "Reservations, arrivals, folios and guest profiles",
  waiter: "Restaurant POS, orders and table service",
  kitchen: "Kitchen display, recipes and stock requests",
  housekeeping: "Room status, cleaning schedules and laundry",
  maintenance: "Work orders, assets and preventive schedules",
  store: "Inventory, stock movements and procurement requests",
  accountant: "Finance, credit accounts, approvals and reports",
  marketing: "Campaigns, CRM, feedback and events pipeline",
  hr: "Staff records, shifts, leave and payroll inputs",
};

function UserDefaultsPage() {
  const { tenant } = useTenant();

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="User Defaults"
        description="Roles ship with the platform. Staff accounts and permissions are wired up when Cloud is connected."
        actions={
          <span className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Platform defaults · read only
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <SectionCard title="Roles" description="Access scope applied across every module">
          <ul className="divide-y divide-border">
            {(Object.keys(roleLabels) as Role[]).map((role) => (
              <li key={role} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{roleLabels[role]}</p>
                  <p className="text-xs text-muted-foreground">{roleScope[role]}</p>
                </div>
                <StatusPill tone={roleReach[role] === "organisation" ? "success" : "default"}>
                  {roleReach[role] === "organisation" ? "Full access" : "Scoped"}
                </StatusPill>
              </li>
            ))}
          </ul>
        </SectionCard>

        <div className="space-y-6">
          <SectionCard title="New account defaults" description="Applied when staff are invited">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Default role</Label>
                <Input readOnly value={roleLabels["front-office"]} />
              </div>
              <div className="space-y-2">
                <Label>Default property</Label>
                <Input readOnly value={tenant.branches[0]?.name || "Main branch"} />
              </div>
              <div className="space-y-2">
                <Label>Default language</Label>
                <Input readOnly value={tenant.regional.language.toUpperCase()} />
              </div>
              {[
                "Require password change on first sign-in",
                "Send branded welcome email",
                "Enable two-factor for managers",
              ].map((label) => (
                <label
                  key={label}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm"
                >
                  {label}
                  <Switch defaultChecked disabled />
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                These switches are visual placeholders until authentication is connected.
              </p>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

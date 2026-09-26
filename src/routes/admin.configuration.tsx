import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Download, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { useTenant } from "@/lib/tenant";

export const Route = createFileRoute("/admin/configuration")({
  head: () => ({
    meta: [
      { title: "White-Label Configuration — System Administration" },
      {
        name: "description",
        content:
          "Export, import or reset the complete white-label configuration for this hospitality organization and re-run the onboarding wizard.",
      },
      { property: "og:title", content: "White-Label Configuration — System Administration" },
      { property: "og:description", content: "Export, import and reset tenant configuration." },
    ],
  }),
  component: ConfigurationPage,
});

function ConfigurationPage() {
  const { tenant, replaceTenant, resetTenant } = useTenant();
  const navigate = useNavigate();

  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(tenant, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tenant.organization.name || "tenant"}-white-label-config.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Configuration exported");
  };

  const importConfig = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        replaceTenant(JSON.parse(String(reader.result)));
        toast.success("Configuration imported");
      } catch {
        toast.error("That file is not a valid configuration export");
      }
    };
    reader.readAsText(file);
  };

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="White-Label Configuration"
        description="Move a tenant profile between environments, or start the setup over."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Configuration snapshot" description="Current tenant state">
          <dl className="divide-y divide-border text-sm">
            {[
              ["Organization", tenant.organization.name || "Not set"],
              ["Business type", tenant.organization.businessType],
              ["Branches", String(tenant.branches.length)],
              ["Currency", `${tenant.regional.currency} (${tenant.regional.currencySymbol})`],
              ["Timezone", tenant.regional.timezone],
              ["Communication templates", String(tenant.communicationTemplates.length)],
              ["Document templates", String(tenant.documentTemplates.length)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 py-2">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="truncate font-medium capitalize">{v}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 py-2">
              <dt className="text-muted-foreground">Onboarding</dt>
              <dd>
                <StatusPill tone={tenant.organization.onboardingCompleted ? "success" : "warning"}>
                  {tenant.organization.onboardingCompleted ? "Completed" : "Incomplete"}
                </StatusPill>
              </dd>
            </div>
          </dl>
        </SectionCard>

        <div className="space-y-6">
          <SectionCard title="Backup & transfer" description="JSON export of every branding setting">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={exportConfig}>
                <Download className="size-4" />
                Export configuration
              </Button>
              <label className="inline-flex">
                <input
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(e) => importConfig(e.target.files?.[0])}
                />
                <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
                  <Upload className="size-4" />
                  Import configuration
                </span>
              </label>
            </div>
          </SectionCard>

          <SectionCard title="Danger zone" description="Reset branding and re-run onboarding">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => navigate({ to: "/onboarding" })}>
                Re-run onboarding wizard
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  resetTenant();
                  toast.success("Tenant configuration reset");
                }}
              >
                <RotateCcw className="size-4" />
                Reset everything
              </Button>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

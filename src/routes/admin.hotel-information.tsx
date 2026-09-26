import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { FieldGrid } from "@/components/common/FormFields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTenant } from "@/lib/tenant";
import { businessTypeLabels, type BusinessType } from "@/lib/tenant-types";

export const Route = createFileRoute("/admin/hotel-information")({
  head: () => ({
    meta: [
      { title: "Hotel Information — System Administration" },
      {
        name: "description",
        content: "Maintain your property name, legal entity, description and contact details.",
      },
      { property: "og:title", content: "Hotel Information — System Administration" },
      { property: "og:description", content: "Property profile and contact information." },
    ],
  }),
  component: HotelInformation,
});

function HotelInformation() {
  const { tenant, updateOrganization, updateContact } = useTenant();
  const org = tenant.organization;
  const contact = tenant.contact;

  return (
    <div>
      <PageHeader
        eyebrow="Business setup"
        title="Hotel Information"
        description="The identity used across dashboards, documents and guest communication."
        actions={
          <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">
            Changes save automatically
          </div>
        }
      />

      <div className="space-y-6">
        <SectionCard title="Property profile" description="Shown to staff and on printed documents">
          <FieldGrid>
            <div className="space-y-2">
              <Label>Hotel / property name</Label>
              <Input value={org.name} onChange={(e) => updateOrganization({ name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Legal business name</Label>
              <Input
                value={org.legalName}
                onChange={(e) => updateOrganization({ legalName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Business type</Label>
              <Select
                value={org.businessType}
                onValueChange={(v) => updateOrganization({ businessType: v as BusinessType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(businessTypeLabels) as BusinessType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {businessTypeLabels[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Short property description</Label>
              <Textarea
                rows={4}
                value={org.description}
                onChange={(e) => updateOrganization({ description: e.target.value })}
              />
            </div>
          </FieldGrid>
        </SectionCard>

        <SectionCard title="Contact information" description="Used on invoices, receipts and messages">
          <FieldGrid>
            <div className="space-y-2 sm:col-span-2">
              <Label>Physical address</Label>
              <Textarea
                rows={3}
                value={contact.address}
                onChange={(e) => updateContact({ address: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Primary phone</Label>
              <Input
                value={contact.phonePrimary}
                onChange={(e) => updateContact({ phonePrimary: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Secondary phone</Label>
              <Input
                value={contact.phoneSecondary}
                onChange={(e) => updateContact({ phoneSecondary: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Business email</Label>
              <Input
                type="email"
                value={contact.email}
                onChange={(e) => updateContact({ email: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Website</Label>
              <Input
                value={contact.website}
                onChange={(e) => updateContact({ website: e.target.value })}
              />
            </div>
          </FieldGrid>
        </SectionCard>
      </div>
    </div>
  );
}

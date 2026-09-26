import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/laundry-pricing")({
  head: () => ({
    meta: [
      { title: "Laundry Pricing — Configuration Centre" },
      {
        name: "description",
        content:
          "Set what this property charges guests for each laundry item, normal and express, so the guest laundry list shows real prices.",
      },
      { property: "og:title", content: "Laundry Pricing — Configuration Centre" },
      {
        property: "og:description",
        content:
          "One price list per property, read by the guest laundry screen and by every laundry charge.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LaundryPricingPage,
});

function LaundryPricingPage() {
  const { can } = useAuth();
  const canEdit =
    can("laundry", "pricing", "manage") ||
    can("laundry", "overview", "edit") ||
    can("laundry", "edit") ||
    can("administration", "workspace", "edit");

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Laundry & linen"
        title="Laundry Pricing"
        description="What this property charges a guest for each laundry item. The guest laundry list, the order estimate and the charge posted to the guest's folio all read these prices — until an item is priced here, guests are told the service is not yet priced rather than shown a made-up figure."
      />
      <ConfigCollection
        table="laundry_price_items"
        title="Price list"
        description="Choose the property on the selector above, then price each item. Prices are per property, so two hotels in the same group can charge differently."
        singular="Laundry item"
        select="id, name, service_type, normal_price, express_price, turnaround_hours, tax_rate, tax_code, active"
        auditModule="laundry"
        canEdit={canEdit}
        labelField="name"
        statusField="active"
        orderBy="name"
        propertyScoped
        renderSummary={(row) =>
          [
            String(row["service_type"] ?? "").trim() || "Service not set",
            `Normal ${String(row["normal_price"] ?? 0)}`,
            row["express_price"] ? `Express ${String(row["express_price"])}` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        }
        fields={[
          {
            name: "name",
            label: "Item",
            type: "text",
            required: true,
            placeholder: "Shirt",
            help: "What the guest sees on the laundry list.",
          },
          {
            name: "service_type",
            label: "Service",
            type: "text",
            required: true,
            placeholder: "wash_and_iron",
            help: "The kind of service this price covers — for example wash, wash and iron, dry clean, press.",
          },
          {
            name: "normal_price",
            label: "Normal price",
            type: "money",
            required: true,
            help: "The standard price for one unit of this item at this property.",
          },
          {
            name: "express_price",
            label: "Express price",
            type: "money",
            help: "Leave empty if this property does not offer express on this item.",
          },
          {
            name: "turnaround_hours",
            label: "Turnaround (hours)",
            type: "number",
            help: "How long the guest is told to expect for the normal service.",
          },
          {
            name: "tax_rate",
            label: "Tax rate (%)",
            type: "number",
            help: "The tax applied when the charge is posted. Leave at zero if the price already includes it.",
          },
          {
            name: "tax_code",
            label: "Tax code",
            type: "text",
            help: "Optional — your own tax code for this line, if your accounting needs one.",
          },
          {
            name: "active",
            label: "Offered",
            type: "switch",
            defaultValue: true,
            help: "Items switched off disappear from the guest list but stay on past orders.",
          },
        ]}
      />
    </div>
  );
}

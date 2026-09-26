import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/linen-catalogue")({
  head: () => ({
    meta: [
      { title: "Linen Catalogue — Configuration Centre" },
      {
        name: "description",
        content:
          "Define the hotel's own linen items — sheets, towels, table linen — with their unit, par level and replacement cost, used by laundry batches, linen movements and loss incidents.",
      },
      { property: "og:title", content: "Linen Catalogue — Configuration Centre" },
      {
        property: "og:description",
        content: "One canonical linen list shared by laundry, housekeeping and linen loss reporting.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LinenCataloguePage,
});

function LinenCataloguePage() {
  const { can } = useAuth();
  // Laundry management owns the catalogue; everyone else reads it through the
  // laundry screens. Workspace administration keeps a way in during setup.
  const canEdit =
    can("laundry", "linen", "manage") ||
    can("laundry", "linen.manage") ||
    can("administration", "workspace", "edit");

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Laundry & linen"
        title="Linen Catalogue"
        description="Every linen item the hotel owns is defined once here. Laundry batches, linen movements between housekeeping and laundry, and loss or damage incidents all read this same list, so a towel is counted, costed and replaced consistently wherever it appears."
      />
      <ConfigCollection
        table="linen_items"
        title="Linen items"
        description="The canonical linen list. Leave a property unset on the property selector to keep an item shared across the group."
        singular="Linen item"
        select="id, name, category, unit, par_level, replacement_cost, active"
        auditModule="laundry"
        canEdit={canEdit}
        labelField="name"
        statusField="active"
        orderBy="name"
        propertyScoped
        renderSummary={(row) =>
          [
            String(row["category"] ?? "").trim() || "Uncategorised",
            `Par ${String(row["par_level"] ?? 0)} ${String(row["unit"] ?? "")}`.trim(),
          ]
            .filter(Boolean)
            .join(" · ")
        }
        fields={[
          {
            name: "name",
            label: "Item name",
            type: "text",
            required: true,
            placeholder: "Bath towel — large",
            help: "One spelling per item. Two linen items in the same property cannot share a name.",
          },
          {
            name: "category",
            label: "Category",
            type: "text",
            required: true,
            placeholder: "Bathroom linen",
            help: "Your own grouping — bed linen, bathroom linen, table linen, uniforms.",
          },
          {
            name: "unit",
            label: "Unit",
            type: "text",
            required: true,
            placeholder: "piece",
            help: "How the item is counted when it is issued, washed and returned.",
          },
          {
            name: "par_level",
            label: "Par level",
            type: "number",
            required: true,
            help: "The quantity this property aims to hold in circulation. Used to flag shortfalls.",
          },
          {
            name: "replacement_cost",
            label: "Replacement cost",
            type: "money",
            required: true,
            help: "What it costs to replace one unit. Linen loss and damage incidents are costed from this.",
          },
          {
            name: "active",
            label: "In use",
            type: "switch",
            defaultValue: true,
            help: "Retired items stay on historic batches and incidents but cannot be added to new ones.",
          },
        ]}
      />
    </div>
  );
}

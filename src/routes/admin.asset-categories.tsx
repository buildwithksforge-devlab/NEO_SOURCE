import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { useAuth } from "@/lib/auth";
import { useAssetCategoryUsage } from "@/lib/operations-data";

export const Route = createFileRoute("/admin/asset-categories")({
  head: () => ({
    meta: [
      { title: "Asset Categories — Configuration Centre" },
      {
        name: "description",
        content:
          "Manage the canonical asset categories used by Assets & Equipment, maintenance planning and asset imports.",
      },
      { property: "og:title", content: "Asset Categories — Configuration Centre" },
      {
        property: "og:description",
        content: "One canonical list of asset categories for the whole hotel group.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AssetCategoriesPage,
});

function AssetCategoriesPage() {
  const { can } = useAuth();
  // Seeing the list travels with the asset register; changing it is the
  // `maintenance.assets.manage` authority (or workspace administration).
  const canEdit =
    can("maintenance", "assets", "manage") ||
    can("maintenance", "assets.manage") ||
    can("administration", "workspace", "edit");
  const usage = useAssetCategoryUsage();
  const counts = usage.data ?? {};
  const inUse = Object.entries(counts).filter(([id]) => id !== "__none__").length;
  const uncategorised = counts["__none__"] ?? 0;

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Assets & equipment"
        title="Asset Categories"
        description="Categories classify every asset — kitchen equipment, furniture, IT, vehicles. Assets & Equipment, maintenance planning and asset imports all read this one list, so each category is defined once for the whole group."
      />
      <ConfigCollection
        table="asset_categories"
        title="Asset categories"
        description="The canonical classification used on every asset record."
        singular="Asset category"
        select="id, name, code, description, useful_life_months, finance_account_id, active"
        auditModule="maintenance"
        canEdit={canEdit}
        labelField="name"
        statusField="active"
        orderBy="name"
        propertyScoped={false}
        fields={[
          {
            name: "name",
            label: "Category name",
            type: "text",
            required: true,
            placeholder: "Kitchen Equipment",
            help: "One spelling per concept — two categories cannot share a name, and imports match against it.",
          },
          {
            name: "code",
            label: "Code",
            type: "text",
            placeholder: "KIT",
            help: "Short code shown on asset registers and reports.",
          },
          {
            name: "description",
            label: "Description",
            type: "textarea",
            placeholder: "What belongs in this category",
            help: "Optional. Helps whoever is registering or importing pick the right one.",
          },
          {
            name: "useful_life_months",
            label: "Useful life (months)",
            type: "number",
            nullable: true,
            help: "Left blank when this category has no standard life.",
          },
          {
            name: "finance_account_id",
            label: "Finance account",
            type: "select",
            lookup: {
              table: "chart_of_accounts",
              propertyScoped: false,
            },
            help: "Optional. Used when asset values are reported against an account.",
          },
          {
            name: "active",
            label: "Available for new assets",
            type: "switch",
            defaultValue: true,
            help: "Turning this off hides the category from new assets. Assets already classified under it keep their history.",
          },
        ]}
        renderSummary={(row) => {
          const used = counts[String(row["id"])] ?? 0;
          return (
            <span>
              {String(row["code"] ?? "No code")}
              {row["useful_life_months"] ? ` · ${String(row["useful_life_months"])} months` : ""}
              {usage.isLoading ? "" : ` · ${used} asset${used === 1 ? "" : "s"}`}
            </span>
          );
        }}
      >
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            {usage.isLoading
              ? "Counting assets per category…"
              : `${inUse} categor${inUse === 1 ? "y is" : "ies are"} currently in use${
                  uncategorised ? `, and ${uncategorised} asset${uncategorised === 1 ? " has" : "s have"} no category yet` : ""
                }.`}
          </p>
          <p>
            Categories created while importing assets appear here immediately.{" "}
            <Link to="/assets" className="text-primary hover:underline">
              Open Assets &amp; Equipment
            </Link>
          </p>
        </div>
      </ConfigCollection>
    </div>
  );
}

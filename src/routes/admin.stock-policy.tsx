import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/stock-policy")({
  head: () => ({
    meta: [
      { title: "Stock Policy — Configuration Centre" },
      {
        name: "description",
        content:
          "Decide whether a store may go below zero when items are issued or sold, for the whole group or for one property.",
      },
      { property: "og:title", content: "Stock Policy — Configuration Centre" },
      {
        property: "og:description",
        content: "One rule for what happens when a store does not have enough of an item to cover an issue or a sale.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StockPolicyPage,
});

function StockPolicyPage() {
  const { can } = useAuth();
  const canEdit =
    can("inventory", "policy", "manage") ||
    can("inventory", "settings.manage") ||
    can("administration", "workspace", "edit");

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Inventory & stores"
        title="Stock policy"
        description="By default a store cannot be taken below zero: an issue, sale or requisition that exceeds what is physically on hand is refused, so the figures on screen match the shelf. Counts, stock takes and corrections are always allowed, because that is how a genuine discrepancy is recorded. Leave the property unset to set the rule for the whole group; add a property row to override it for one hotel."
      />
      <ConfigCollection
        table="inventory_policies"
        title="Negative stock rules"
        description="One row for the group, plus an optional row per property. The property rule wins where both exist."
        singular="Stock policy"
        select="id, allow_negative_stock, note"
        auditModule="inventory"
        canEdit={canEdit}
        labelField="note"
        orderBy="created_at"
        propertyScoped
        renderSummary={(row) =>
          row["allow_negative_stock"]
            ? "Issues may take a store below zero"
            : "Issues are refused when stock is short"
        }
        fields={[
          {
            name: "allow_negative_stock",
            label: "Allow stores to go below zero",
            type: "switch",
            defaultValue: false,
            help: "Off is the safe setting. Turn it on only where stock is counted after the fact rather than at the point of issue.",
          },
          {
            name: "note",
            label: "Why this rule",
            type: "text",
            placeholder: "Central store counts daily",
            help: "A short reason, kept with the change history.",
          },
        ]}
      />
    </div>
  );
}

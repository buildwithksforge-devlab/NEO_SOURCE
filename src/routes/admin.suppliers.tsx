import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/suppliers")({
  head: () => ({
    meta: [
      { title: "Suppliers — Configuration Centre" },
      {
        name: "description",
        content:
          "Configure the suppliers procurement may raise purchase orders against, with their terms and contacts.",
      },
      { property: "og:title", content: "Suppliers — Configuration Centre" },
      {
        property: "og:description",
        content: "Canonical supplier records behind every purchase request, order and invoice.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SuppliersPage,
});

function SuppliersPage() {
  const { can } = useAuth();
  const canSuppliers =
    can("administration", "workspace", "edit") || can("procurement", "suppliers", "edit");

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Configuration Centre · Procurement"
        title="Suppliers"
        description="Vendors procurement may order from. Stock items, categories, item groups and the physical stores that hold them are configured under Inventory & Stores."
      />

      <p className="mb-4 text-sm text-muted-foreground">
        Looking for stock items, categories or stores?{" "}
        <Link to="/inventory/items" className="font-medium text-primary underline-offset-4 hover:underline">
          Open Inventory &amp; Stores configuration
        </Link>
        .
      </p>

      <ConfigCollection
        table="suppliers"
        title="Suppliers"
        description="Vendors that procurement may raise purchase orders against."
        singular="Supplier"
        select="id, name, code, contact_person, phone, whatsapp, email, tax_id, categories, credit_terms_days, payment_terms, currency, preferred, active, branch_id"
        auditModule="procurement"
        canEdit={canSuppliers}
        statusField="active"
        fields={[
          { name: "name", label: "Supplier name", type: "text", required: true },
          {
            name: "code",
            label: "Supplier code",
            type: "text",
            placeholder: "SUP-001",
            help: "Optional short code used on purchase orders.",
          },
          { name: "contact_person", label: "Contact person", type: "text" },
          { name: "phone", label: "Phone", type: "text" },
          {
            name: "whatsapp",
            label: "WhatsApp number",
            type: "text",
            help: "Used when a request for quotation is prepared for WhatsApp.",
          },
          { name: "email", label: "Email", type: "text" },
          {
            name: "tax_id",
            label: "Tax / PIN",
            type: "text",
            help: "Required on tax-compliant purchase documents.",
          },
          {
            name: "categories",
            label: "Supply categories",
            type: "list",
            placeholder: "Produce, Beverages, Housekeeping",
            help: "Comma separated. Used to suggest suppliers when raising a requisition.",
          },
          { name: "credit_terms_days", label: "Credit terms (days)", type: "number", defaultValue: 0 },
          { name: "payment_terms", label: "Payment terms", type: "text", placeholder: "30 days from invoice" },
          { name: "address", label: "Address", type: "textarea" },
          { name: "preferred", label: "Preferred supplier", type: "switch", defaultValue: false },
          { name: "active", label: "Active", type: "switch", defaultValue: true },
        ]}
        renderSummary={(row) => (
          <span>
            {String(row["code"] ?? "No code")} ·{" "}
            {Array.isArray(row["categories"]) && row["categories"].length
              ? (row["categories"] as string[]).join(", ")
              : "No categories"}
          </span>
        )}
      />
    </div>
  );
}

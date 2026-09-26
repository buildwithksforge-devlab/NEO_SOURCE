import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/meal-plans")({
  head: () => ({
    meta: [
      { title: "Meal Plans — Configuration Centre" },
      {
        name: "description",
        content:
          "Configure the meal plans sold with room rates — room only, bed and breakfast, half board and full board.",
      },
      { property: "og:title", content: "Meal Plans — Configuration Centre" },
      { property: "og:description", content: "Canonical meal plan configuration for every property." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MealPlansPage,
});

function MealPlansPage() {
  const { can } = useAuth();
  const canEdit = can("administration", "workspace", "edit") || can("front-office", "rates", "edit");

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Hotel operations"
        title="Meal Plans"
        description="Meal plans attach board arrangements to room rates. Reservations, folios and F&B allowances all read these records, so each plan is defined once per property."
      />
      <ConfigCollection
        table="meal_plans"
        title="Meal plans"
        description="Board arrangements available when quoting and booking rooms."
        singular="Meal plan"
        select="id, code, name, description, includes, status, branch_id"
        auditModule="front-office"
        canEdit={canEdit}
        labelField="name"
        statusField="status"
        orderBy="code"
        fields={[
          { name: "code", label: "Code", type: "text", required: true, placeholder: "BB", help: "Short code used on rates and reports." },
          { name: "name", label: "Name", type: "text", required: true, placeholder: "Bed & Breakfast" },
          { name: "description", label: "Description", type: "textarea", placeholder: "What the guest receives on this plan." },
          {
            name: "includes",
            label: "Included services",
            type: "list",
            placeholder: "Breakfast, Welcome drink",
            help: "Comma separated. These appear on quotations and folio statements.",
          },
          {
            name: "status",
            label: "Status",
            type: "select",
            defaultValue: "active",
            options: [
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ],
          },
        ]}
        renderSummary={(row) => (
          <span>
            {String(row["code"] ?? "—")}
            {Array.isArray(row["includes"]) && row["includes"].length
              ? ` · ${(row["includes"] as string[]).join(", ")}`
              : ""}
          </span>
        )}
      />
    </div>
  );
}

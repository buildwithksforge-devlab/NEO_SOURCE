import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/maintenance-categories")({
  head: () => ({
    meta: [
      { title: "Maintenance Categories — Configuration Centre" },
      {
        name: "description",
        content:
          "Fault categories used on every work order, with the default priority and the response and resolution targets that drive escalation.",
      },
      { property: "og:title", content: "Maintenance Categories — Configuration Centre" },
      {
        property: "og:description",
        content: "One canonical list of maintenance fault categories and their service targets.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MaintenanceCategoriesPage,
});

function MaintenanceCategoriesPage() {
  const { can } = useAuth();
  const canEdit =
    can("maintenance", "overview", "edit") ||
    can("maintenance", "edit") ||
    can("administration", "workspace", "edit");

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Maintenance"
        title="Maintenance Categories"
        description="Every fault reported by the hotel is filed under one of these categories. The response and resolution targets recorded here are what decide when a job is overdue and escalates — they are not decoration."
      />
      <ConfigCollection
        table="maintenance_categories"
        title="Fault categories"
        description="Used on the work-order form, in reporting and by the overdue check."
        singular="Fault category"
        select="id, name, code, default_priority, response_target_minutes, resolution_target_minutes, active"
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
            placeholder: "Electrical",
            help: "What the hotel calls this kind of fault.",
          },
          {
            name: "code",
            label: "Code",
            type: "text",
            placeholder: "ELEC",
            help: "Short code stored on the work order and shown on reports.",
          },
          {
            name: "default_priority",
            label: "Default priority",
            type: "select",
            options: [
              { value: "low", label: "Low" },
              { value: "normal", label: "Normal" },
              { value: "high", label: "High" },
              { value: "urgent", label: "Urgent" },
              { value: "emergency", label: "Emergency" },
            ],
            help: "Pre-selected when someone reports this kind of fault.",
          },
          {
            name: "response_target_minutes",
            label: "Response target (minutes)",
            type: "number",
            nullable: true,
            help: "A job of this kind with nobody assigned after this long is escalated. Leave blank for no target.",
          },
          {
            name: "resolution_target_minutes",
            label: "Resolution target (minutes)",
            type: "number",
            nullable: true,
            help: "A job still open after this long is escalated to the next level. Leave blank for no target.",
          },
          {
            name: "active",
            label: "Available for new work orders",
            type: "switch",
            defaultValue: true,
            help: "Turning this off hides the category from new faults. Existing work orders keep their history.",
          },
        ]}
        renderSummary={(row) => (
          <span>
            {String(row["code"] ?? "No code")}
            {row["default_priority"] ? ` · ${String(row["default_priority"])} by default` : ""}
            {row["resolution_target_minutes"]
              ? ` · resolve within ${String(row["resolution_target_minutes"])} min`
              : " · no resolution target"}
          </span>
        )}
      >
        <p className="text-sm text-muted-foreground">
          Categories without targets never escalate.{" "}
          <Link to="/maintenance" className="text-primary hover:underline">
            Open Maintenance
          </Link>
        </p>
      </ConfigCollection>
    </div>
  );
}

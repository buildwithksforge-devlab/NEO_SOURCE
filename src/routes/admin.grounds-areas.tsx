import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/grounds-areas")({
  head: () => ({
    meta: [
      { title: "Grounds Areas — Configuration Centre" },
      {
        name: "description",
        content:
          "The lawns, car parks, walkways and garden areas grounds work is planned and recorded against.",
      },
      { property: "og:title", content: "Grounds Areas — Configuration Centre" },
      {
        property: "og:description",
        content: "One canonical list of grounds areas per property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GroundsAreasPage,
});

function GroundsAreasPage() {
  const { can } = useAuth();
  const canEdit =
    can("maintenance", "grounds", "edit") ||
    can("maintenance", "landscaping", "edit") ||
    can("administration", "workspace", "edit");

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Maintenance"
        title="Grounds Areas"
        description="Grounds and landscaping work is planned against these areas. Each property keeps its own list, so a task, a recurring schedule and the history all name the same place."
      />
      <ConfigCollection
        table="grounds_areas"
        title="Grounds areas"
        description="Named outdoor areas for this property."
        singular="Grounds area"
        select="id, name, code, notes, active, branch_id"
        auditModule="maintenance"
        canEdit={canEdit}
        labelField="name"
        statusField="active"
        orderBy="name"
        fields={[
          {
            name: "name",
            label: "Area name",
            type: "text",
            required: true,
            placeholder: "Main lawn",
            help: "Two areas at the same property cannot share a name.",
          },
          {
            name: "code",
            label: "Code",
            type: "text",
            placeholder: "LAWN",
          },
          {
            name: "notes",
            label: "Notes",
            type: "textarea",
            placeholder: "Access, equipment or safety notes for whoever works here",
          },
          {
            name: "active",
            label: "Available for new work",
            type: "switch",
            defaultValue: true,
            help: "Turning this off hides the area from new tasks. Completed work keeps its history.",
          },
        ]}
        renderSummary={(row) => <span>{String(row["code"] ?? "No code")}</span>}
      >
        <p className="text-sm text-muted-foreground">
          Areas appear on the grounds board and the landscaping programme.{" "}
          <Link to="/maintenance/grounds" className="text-primary hover:underline">
            Open Grounds
          </Link>
        </p>
      </ConfigCollection>
    </div>
  );
}

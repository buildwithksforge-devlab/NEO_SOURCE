import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { PickupPointCard } from "@/components/delivery/PickupPointCard";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/delivery-zones")({
  head: () => ({
    meta: [
      { title: "Delivery Zones & Fees — Configuration Centre" },
      {
        name: "description",
        content:
          "Configure the delivery areas each property serves, with minimum order values, fees, free-delivery thresholds and service hours.",
      },
      { property: "og:title", content: "Delivery Zones & Fees — Configuration Centre" },
      { property: "og:description", content: "Canonical delivery zone and fee configuration per property." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DeliveryZonesPage,
});

function DeliveryZonesPage() {
  const { can } = useAuth();
  const canEdit = can("administration", "workspace", "edit") || can("delivery", "settings", "edit");

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Delivery"
        title="Delivery Zones & Fees"
        description="Guest ordering quotes a delivery fee from these zones, and dispatch only offers orders inside a served area. A property with no zone cannot take delivery orders."
      />
      <div className="mb-6">
        <PickupPointCard canEdit={canEdit} />
      </div>
      <ConfigCollection
        table="delivery_zones"
        title="Delivery zones"
        description="Areas served by this property, with the commercial rules applied to each order."
        singular="Zone"
        select="id, name, description, areas, min_order, base_fee, distance_fee_per_km, configured_distance_km, free_delivery_threshold, max_distance_km, eta_minutes, service_start, service_end, active, branch_id"
        auditModule="delivery"
        canEdit={canEdit}
        statusField="active"
        fields={[
          { name: "name", label: "Zone name", type: "text", required: true, placeholder: "City centre" },
          { name: "description", label: "Description", type: "textarea" },
          {
            name: "areas",
            label: "Areas covered",
            type: "list",
            placeholder: "Westlands, Parklands, Kilimani",
            help: "Comma separated. Guest addresses are matched against these names.",
          },
          { name: "min_order", label: "Minimum order", type: "money", defaultValue: 0 },
          { name: "base_fee", label: "Base delivery fee", type: "money", defaultValue: 0 },
          { name: "distance_fee_per_km", label: "Fee per km", type: "money", defaultValue: 0 },
          {
            name: "configured_distance_km",
            label: "Reference route distance (km)",
            type: "number",
            help: "Enter the verified zone distance used for rider comparisons. Leave blank when it is not known.",
          },
          {
            name: "free_delivery_threshold",
            label: "Free delivery above",
            type: "money",
            help: "Leave at zero when the property never waives the fee.",
            defaultValue: 0,
          },
          { name: "max_distance_km", label: "Maximum distance (km)", type: "number", defaultValue: 0 },
          { name: "eta_minutes", label: "Promised ETA (minutes)", type: "number", defaultValue: 45 },
          { name: "service_start", label: "Service starts", type: "time", defaultValue: "08:00" },
          { name: "service_end", label: "Service ends", type: "time", defaultValue: "22:00" },
          { name: "active", label: "Active", type: "switch", defaultValue: true },
        ]}
        renderSummary={(row) => (
          <span>
            {Array.isArray(row["areas"]) && row["areas"].length
              ? (row["areas"] as string[]).join(", ")
              : "No areas mapped"}{" "}
            · fee {String(row["base_fee"] ?? 0)} · ETA {String(row["eta_minutes"] ?? "—")} min
          </span>
        )}
      />
    </div>
  );
}

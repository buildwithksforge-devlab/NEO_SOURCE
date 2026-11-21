import { createFileRoute } from "@tanstack/react-router";
import { ProductionDisplay } from "@/components/kitchen/ProductionDisplay";
import { productionDisplaySearch } from "@/lib/production-displays";

export const Route = createFileRoute("/_shell/bar/display")({
  validateSearch: productionDisplaySearch,
  component: DisplayPage,
});
function DisplayPage() {
  const { station, property } = Route.useSearch();
  return <ProductionDisplay department="bar" requestedStation={station} requestedProperty={property} />;
}

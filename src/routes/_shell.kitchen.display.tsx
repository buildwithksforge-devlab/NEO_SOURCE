import { createFileRoute } from "@tanstack/react-router";
import { ProductionDisplay } from "@/components/kitchen/ProductionDisplay";
import { productionDisplaySearch } from "@/lib/production-displays";

export const Route = createFileRoute("/_shell/kitchen/display")({
  validateSearch: productionDisplaySearch,
  component: DisplayPage,
});
function DisplayPage() {
  const { station, property } = Route.useSearch();
  return <ProductionDisplay department="kitchen" requestedStation={station} requestedProperty={property} />;
}

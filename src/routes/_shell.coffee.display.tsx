import { createFileRoute } from "@tanstack/react-router";
import { ProductionDisplay } from "@/components/kitchen/ProductionDisplay";
import { productionDisplaySearch } from "@/lib/production-displays";

export const Route = createFileRoute("/_shell/coffee/display")({
  validateSearch: productionDisplaySearch,
  component: DisplayPage,
});
function DisplayPage() {
  const { station, property } = Route.useSearch();
  return <ProductionDisplay department="coffee" requestedStation={station} requestedProperty={property} />;
}

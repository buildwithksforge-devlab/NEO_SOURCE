import { createFileRoute, Link } from "@tanstack/react-router";
import { ProductionDisplay } from "@/components/kitchen/ProductionDisplay";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { productionDisplaySearch } from "@/lib/production-displays";

export const Route = createFileRoute("/_shell/coffee/display")({
  validateSearch: productionDisplaySearch,
  component: DisplayPage,
});
function DisplayPage() {
  const { station, property } = Route.useSearch();
  const { can } = useAuth();

  return (
    <>
      {can("kitchen", "production.view") ||
       can("kitchen", "production.manage") ? (
        <div className="flex flex-wrap gap-2 p-3">
          <Button asChild variant="outline" size="sm">
            <Link to="/coffee/production">
              Beverage & juice production
            </Link>
          </Button>
        </div>
      ) : null}

      <ProductionDisplay
        department="coffee"
        requestedStation={station}
        requestedProperty={property}
      />
    </>
  );
}

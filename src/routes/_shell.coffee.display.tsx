import { createFileRoute } from "@tanstack/react-router";
import { ProductionDisplay } from "@/components/kitchen/ProductionDisplay";

export const Route = createFileRoute("/_shell/coffee/display")({
  validateSearch: (search: Record<string, unknown>): { station?: string | undefined } => ({
    station: typeof search["station"] === "string" ? search["station"] : undefined,
  }),
  component: DisplayPage,
});
function DisplayPage() {
  const { station } = Route.useSearch();
  return <ProductionDisplay department="coffee" requestedStation={station} />;
}

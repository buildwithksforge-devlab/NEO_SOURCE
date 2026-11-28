import { createFileRoute, Link } from "@tanstack/react-router";
import { KitchenGuard } from "@/components/kitchen/KitchenShared";
import { ProductionBatchWorkspace } from "@/components/kitchen/ProductionBatchWorkspace";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_shell/coffee/production")({
  head: () => ({
    meta: [
      { title: "Coffee production - NEO" },
      {
        name: "description",
        content: "Coffee station beverage and fresh juice production.",
      },
    ],
  }),
  component: () => (
    <KitchenGuard action="view">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/coffee/display">Coffee orders</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/station-stock">Station stock</Link>
          </Button>
        </div>
        <ProductionBatchWorkspace department="coffee" />
      </div>
    </KitchenGuard>
  ),
});

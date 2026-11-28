import { createFileRoute } from "@tanstack/react-router";
import { KitchenGuard } from "@/components/kitchen/KitchenShared";
import { ProductionBatchWorkspace } from "@/components/kitchen/ProductionBatchWorkspace";

export const Route = createFileRoute("/_shell/kitchen/production")({
  head: () => ({
    meta: [
      { title: "Production batches - NEO" },
      {
        name: "description",
        content: "Batch production, planned and actual quantities.",
      },
    ],
  }),
  component: () => (
    <KitchenGuard action="view">
      <ProductionBatchWorkspace department="kitchen" />
    </KitchenGuard>
  ),
});

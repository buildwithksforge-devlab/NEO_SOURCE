/**
 * Kitchen stock count.
 *
 * The kitchen reaches the same controlled counting workflow Stores uses — open
 * a count, record the physical quantities, send every difference for approval —
 * without leaving the kitchen section. It is deliberately the same engine and
 * the same approval rules: a counted figure never overwrites the ledger
 * silently, whichever section it was entered from.
 */
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { StockCountsPage } from "./_shell.inventory.counts";

export const Route = createFileRoute("/_shell/kitchen/stock-count")({
  head: () => ({
    meta: [
      { title: "Kitchen stock count — NEØ" },
      {
        name: "description",
        content:
          "Count kitchen ingredients against the ledger and send every difference for approval before it changes stock.",
      },
      { property: "og:title", content: "Kitchen stock count — NEØ" },
      {
        property: "og:description",
        content: "Count, investigate the variance, then approve the adjustment — the same rules as Stores.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="stores" action="counts.view">
      <StockCountsPage />
    </OpsGuard>
  ),
});

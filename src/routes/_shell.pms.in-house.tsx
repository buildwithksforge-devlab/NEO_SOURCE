import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { PmsGuard } from "@/components/pms/PmsShared";
import { MovementBoard } from "@/components/pms/MovementBoard";
import { CheckInReconciliation } from "@/components/pms/CheckInReconciliation";

export const Route = createFileRoute("/_shell/pms/in-house")({
  head: () => ({
    meta: [
      { title: "In-house Guests — NEØ" },
      {
        name: "description",
        content: "Guests currently in residence, with folio balances, room moves and charges.",
      },
      { property: "og:title", content: "In-house Guests — NEØ" },
      {
        property: "og:description",
        content: "Guests currently in residence, with folio balances, room moves and charges.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="in-house.view">
      <div className="space-y-6">
        <PageHeader
          eyebrow="Front Office"
          title="In-house Guests"
          description="Room moves keep the folio, charges and stay history attached to the guest."
        />
        <MovementBoard scope="in-house" />
        <CheckInReconciliation />
      </div>
    </PmsGuard>
  ),
});

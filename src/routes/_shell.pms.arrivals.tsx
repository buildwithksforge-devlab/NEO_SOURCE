import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { PmsGuard } from "@/components/pms/PmsShared";
import { MovementBoard } from "@/components/pms/MovementBoard";

export const Route = createFileRoute("/_shell/pms/arrivals")({
  head: () => ({
    meta: [
      { title: "Arrivals & Check-in — NEØ" },
      {
        name: "description",
        content: "Today's expected arrivals with room assignment, identity checks and check-in.",
      },
      { property: "og:title", content: "Arrivals & Check-in — NEØ" },
      {
        property: "og:description",
        content: "Today's expected arrivals with room assignment, identity checks and check-in.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="arrivals.view">
      <div>
        <PageHeader
          eyebrow="Front Office"
          title="Arrivals & Check-in"
          description="Assign a room from live availability, confirm identity, then open the guest folio."
        />
        <MovementBoard scope="arrivals" />
      </div>
    </PmsGuard>
  ),
});

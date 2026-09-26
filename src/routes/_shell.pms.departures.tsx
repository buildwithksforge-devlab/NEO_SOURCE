import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { PmsGuard } from "@/components/pms/PmsShared";
import { MovementBoard } from "@/components/pms/MovementBoard";

export const Route = createFileRoute("/_shell/pms/departures")({
  head: () => ({
    meta: [
      { title: "Departures & Check-out — NEØ" },
      {
        name: "description",
        content: "Settle folios, record payments and release rooms as guests depart.",
      },
      { property: "og:title", content: "Departures & Check-out — NEØ" },
      {
        property: "og:description",
        content: "Settle folios, record payments and release rooms as guests depart.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="departures.view">
      <div>
        <PageHeader
          eyebrow="Front Office"
          title="Departures & Check-out"
          description="A folio with an outstanding balance cannot be closed without an authorised override."
        />
        <MovementBoard scope="departures" />
      </div>
    </PmsGuard>
  ),
});

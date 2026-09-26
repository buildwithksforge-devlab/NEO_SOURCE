import { createFileRoute } from "@tanstack/react-router";
import { PmsGuard } from "@/components/pms/PmsShared";
import { AvailabilityPage } from "@/components/pms/AvailabilitySearchPage";
import { parseAvailabilitySearch } from "@/lib/availability-search";

export const Route = createFileRoute("/_shell/pms/availability")({
  validateSearch: parseAvailabilitySearch,
  head: () => ({
    meta: [
      { title: "Availability Search — NEØ" },
      {
        name: "description",
        content: "Check which rooms are genuinely free for a date range, party size and room type.",
      },
      { property: "og:title", content: "Availability Search — NEØ" },
      {
        property: "og:description",
        content: "Check which rooms are genuinely free for a date range, party size and room type.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="availability.view">
      <AvailabilityPage />
    </PmsGuard>
  ),
});

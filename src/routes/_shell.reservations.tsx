import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy path kept so old links, bookmarks and saved dashboards keep working.
 * The operational module now lives at /pms/reservations.
 */
export const Route = createFileRoute("/_shell/reservations")({
  beforeLoad: () => {
    throw redirect({ to: "/pms/reservations", replace: true });
  },
  component: () => null,
});

import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy path kept so old links, bookmarks and saved dashboards keep working.
 * The operational module now lives at /pms/rooms.
 */
export const Route = createFileRoute("/_shell/rooms")({
  beforeLoad: () => {
    throw redirect({ to: "/pms/rooms", replace: true });
  },
  component: () => null,
});

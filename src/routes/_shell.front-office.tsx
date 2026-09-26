import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy path kept so old links, bookmarks and saved dashboards keep working.
 * The operational module now lives at /pms.
 */
export const Route = createFileRoute("/_shell/front-office")({
  beforeLoad: () => {
    throw redirect({ to: "/pms", replace: true });
  },
  component: () => null,
});

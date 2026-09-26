import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy path kept so old links, bookmarks and saved dashboards keep working.
 * The operational module now lives at /crm/customers.
 */
export const Route = createFileRoute("/_shell/guests")({
  beforeLoad: () => {
    throw redirect({ to: "/crm/customers", replace: true });
  },
  component: () => null,
});

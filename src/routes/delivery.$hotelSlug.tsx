import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PublicWorkspaceProvider, WorkspaceNotFound } from "@/components/public/PublicAppShell";
import { resolvePublicWorkspace } from "@/lib/public-apps.functions";
import { useTrackEntry } from "@/lib/traffic";

export const Route = createFileRoute("/delivery/$hotelSlug")({
  loader: ({ params }) =>
    resolvePublicWorkspace({ data: { appKey: "delivery", slug: params.hotelSlug } }),
  head: ({ loaderData }) => {
    const name = loaderData?.hotel_name || "Delivery App";
    const title = `${name} — Order food for delivery or pickup`;
    const description =
      loaderData?.welcome_message ||
      "Browse the menu, order for delivery or collection, and track your order live.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary" },
        ...(loaderData ? [] : [{ name: "robots", content: "noindex" }]),
      ],
    };
  },
  component: DeliveryAppLayout,
});

function DeliveryAppLayout() {
  const workspace = Route.useLoaderData();
  const { hotelSlug } = Route.useParams();
  useTrackEntry(hotelSlug, "delivery");
  if (!workspace) return <WorkspaceNotFound appLabel="Delivery App" />;
  return (
    <PublicWorkspaceProvider workspace={workspace}>
      <Outlet />
    </PublicWorkspaceProvider>
  );
}

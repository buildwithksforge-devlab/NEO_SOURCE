import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PublicWorkspaceProvider, WorkspaceNotFound } from "@/components/public/PublicAppShell";
import { resolvePublicWorkspace } from "@/lib/public-apps.functions";
import { useTrackEntry } from "@/lib/traffic";

export const Route = createFileRoute("/guest/$hotelSlug")({
  loader: ({ params }) =>
    resolvePublicWorkspace({ data: { appKey: "guest", slug: params.hotelSlug } }),
  head: ({ loaderData }) => {
    const name = loaderData?.hotel_name || "Guest App";
    const title = `${name} — Guest App`;
    const description =
      loaderData?.welcome_message ||
      "Book rooms, manage your stay, order room service and view your folio.";
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
  component: GuestAppLayout,
});

function GuestAppLayout() {
  const workspace = Route.useLoaderData();
  const { hotelSlug } = Route.useParams();
  useTrackEntry(hotelSlug, "stay_dine");
  if (!workspace) return <WorkspaceNotFound appLabel="Guest App" />;
  return (
    <PublicWorkspaceProvider workspace={workspace}>
      <Outlet />
    </PublicWorkspaceProvider>
  );
}

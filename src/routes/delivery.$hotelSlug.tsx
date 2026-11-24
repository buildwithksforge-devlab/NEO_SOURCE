import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
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
        ...(loaderData?.branch_id ? [{ name: "neo-public-property", content: `delivery:${loaderData.branch_id}` }] : []),
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
  errorComponent: DeliveryPublicationError,
});

function DeliveryPublicationError() {
  const router = useRouter();
  return (
    <main className="neo-public-app grid place-items-center p-6">
      <div className="neo-public-panel max-w-md p-6">
        <h1 className="text-xl font-semibold">Delivery couldn’t load</h1>
        <p className="mt-2 text-sm text-white/80">We couldn’t check this property’s published app. Try the same link again.</p>
        <button className="neo-commerce-primary mt-4" onClick={() => void router.invalidate()}>Retry</button>
      </div>
    </main>
  );
}
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

/**
 * THE NEØ ROOT.
 *
 * Authentication is never the first page of NEØ. This route is public and owns
 * "/" outright: it is not inside the staff shell, so no session lookup, no
 * workspace resolution and no route guard runs before a visitor sees it. The
 * staff workspace lives at /workspace and still gates itself.
 */
import { createFileRoute } from "@tanstack/react-router";
import { FrontDoorScreen } from "@/components/front-door/FrontDoorScreen";
import { canonicalLink, canonicalUrl, robotsDirective } from "@/lib/route-visibility";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "NEØ — hospitality, connected" },
      {
        name: "description",
        content:
          "Find a hotel running on NEØ, then continue as a guest, a member of staff, a business partner or a delivery rider.",
      },
      { property: "og:title", content: "NEØ — hospitality, connected" },
      {
        property: "og:description",
        content: "One entrance to every hotel running on NEØ.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl("/") },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: robotsDirective("/") },
    ],
    links: [canonicalLink("/")],
  }),
  component: FrontDoorScreen,
});

import { createFileRoute } from "@tanstack/react-router";
import { FrontDoorScreen } from "@/components/front-door/FrontDoorScreen";

export const Route = createFileRoute("/start/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "NEØ — find your hotel" },
      {
        name: "description",
        content:
          "The NEØ front door. Find a participating hotel, then continue as a guest, a member of staff, a business partner or a delivery rider.",
      },
      { property: "og:title", content: "NEØ — find your hotel" },
      {
        property: "og:description",
        content: "One entrance to every hotel running on NEØ.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FrontDoorScreen,
});

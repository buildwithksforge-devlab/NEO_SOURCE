import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { publicAppLabels, type PublicAppKey } from "@/lib/public-apps";
import { publicUrlFor, usePublicWorkspaces } from "@/lib/public-apps-data";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";

/** Shows the live public links for the published Guest, Delivery and Rider apps. */
export function PublicAppLinks() {
  const workspaces = usePublicWorkspaces();
  const live = (workspaces.data ?? []).filter((w) => w.published && w.status === "published");

  return (
    <SectionCard
      title="Public app links"
      description="Share these addresses with guests, customers and riders."
    >
      {workspaces.isLoading ? (
        <LoadingState variant="rows" rows={2} />
      ) : live.length === 0 ? (
        <EmptyState
          title="No public workspaces published"
          description="Use the publishing controls on an app tab below to publish one and generate its link."
        />
      ) : (
        <ul className="space-y-3">
          {live.map((ws) => {
            const appKey = ws.app_key as PublicAppKey;
            const url = publicUrlFor(appKey, ws.slug);
            return (
              <li
                key={ws.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{publicAppLabels[appKey] ?? appKey}</p>
                  <p className="truncate text-xs text-muted-foreground">{url}</p>
                  <p className="text-xs text-muted-foreground">
                    Published {ws.published_at ? new Date(ws.published_at).toLocaleString() : "—"}
                    {ws.published_by_name ? ` by ${ws.published_by_name}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(url);
                      toast.success("Link copied");
                    }}
                  >
                    <Copy className="size-3.5" />
                    Copy
                  </Button>
                  <Button variant="ghost" size="sm" asChild>
                    <a href={url} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3.5" />
                      Open
                    </a>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

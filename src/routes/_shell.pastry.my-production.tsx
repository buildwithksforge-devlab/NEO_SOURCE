import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  DueLabel,
  EmptyState,
  PastryGuard,
  PastryStatusBadge,
  QueryState,
} from "@/components/pastry/PastryShared";
import { Button } from "@/components/ui/button";
import {
  nextCustomCakeStatus,
  nextPastryStatus,
  pastryNum,
  pastryStr,
  useAdvanceCustomCake,
  useAdvancePastryItem,
  useMyPastryWork,
  type PastryRow,
} from "@/lib/pastry-department";
import { titleCase } from "@/lib/kitchen";

export const Route = createFileRoute("/_shell/pastry/my-production")({
  head: () => ({
    meta: [
      { title: "My Pastry Production — NEØ" },
      {
        name: "description",
        content:
          "A Pastry Chef's own assigned production and custom cakes, with quantity, due time and finishing instructions — and no guest billing.",
      },
      { property: "og:title", content: "My Pastry Production — NEØ" },
      {
        property: "og:description",
        content: "Only the pastry work assigned to you, moved forward one step at a time.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PastryGuard feature="pastry-production">
      <MyPastryProductionPage />
    </PastryGuard>
  ),
});

function MyPastryProductionPage() {
  const work = useMyPastryWork();
  const advanceItem = useAdvancePastryItem();
  const advanceCake = useAdvanceCustomCake();

  const rows = (work.data ?? []) as PastryRow[];

  return (
    <div>
      <PageHeader
        eyebrow="Pastry & Bakery"
        title="My production"
        description="Everything assigned to you — planned bakery output and custom cakes. Move each one forward as you work: preparation, decorating, then ready."
      />

      <SectionCard title="Assigned to me" description="Nothing here shows what a guest paid.">
        <QueryState
          isLoading={work.isLoading}
          error={work.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="Nothing assigned"
              description="When the Head Pastry Chef assigns you production or a custom cake, it appears here."
            />
          }
        >
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((r) => {
              const status = String(r["status"]);
              const isCustom = String(r["source"]) === "custom";
              const next = isCustom ? nextCustomCakeStatus(status) : nextPastryStatus(status);
              const id = String(r["id"]);
              return (
                <div
                  key={`${r["source"]}-${id}`}
                  className="rounded-xl border border-border/70 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{pastryStr(r["product"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {pastryStr(r["reference"])} · {pastryNum(r["quantity"])}{" "}
                        {pastryStr(r["unit"], "piece")}
                        {isCustom ? " · custom cake" : ""}
                      </p>
                      <DueLabel value={r["due_at"] as string | null} />
                    </div>
                    <PastryStatusBadge status={status} />
                  </div>

                  {r["flavour"] ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Flavour: {pastryStr(r["flavour"])}
                    </p>
                  ) : null}
                  {r["cake_message"] ? (
                    <p className="mt-1 rounded-lg border border-border/70 bg-muted/40 p-2 text-xs">
                      Message on cake: “{pastryStr(r["cake_message"])}”
                    </p>
                  ) : null}
                  {r["special_instructions"] ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {pastryStr(r["special_instructions"])}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {next ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          if (isCustom) {
                            advanceCake.mutate({ orderId: id, status: next });
                            return;
                          }
                          if (next === "ready") {
                            const produced = window.prompt(
                              "How many did you produce?",
                              String(pastryNum(r["quantity"])),
                            );
                            if (produced === null) return;
                            advanceItem.mutate({
                              itemId: id,
                              status: next,
                              produced: Number(produced),
                            });
                            return;
                          }
                          advanceItem.mutate({ itemId: id, status: next });
                        }}
                      >
                        Mark {titleCase(next)}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Waiting on the Head Pastry Chef to close this off.
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

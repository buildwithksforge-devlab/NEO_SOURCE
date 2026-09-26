import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, PastryGuard, QueryState } from "@/components/pastry/PastryShared";
import { awaitingReceipt, ConfirmReceiptButton } from "@/components/common/ConfirmReceiptButton";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/kitchen";
import { pastryStr, usePastryRequisitions, type PastryRow } from "@/lib/pastry-department";

export const Route = createFileRoute("/_shell/pastry/requisitions")({
  head: () => ({
    meta: [
      { title: "Pastry Requisitions — NEØ" },
      {
        name: "description",
        content:
          "Every Stores requisition raised for Pastry & Bakery by the Head Pastry Chef, with its approval and issue status.",
      },
      { property: "og:title", content: "Pastry Requisitions — NEØ" },
      {
        property: "og:description",
        content: "Requisitions raised for the bakery and where each one stands with Stores.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PastryGuard feature="pastry-requisition">
      <PastryRequisitionsPage />
    </PastryGuard>
  ),
});

function reqTone(status: string): "success" | "warning" | "destructive" | "default" {
  if (["issued", "received", "closed", "approved"].includes(status)) return "success";
  if (["rejected", "cancelled"].includes(status)) return "destructive";
  if (status.startsWith("pending")) return "warning";
  return "default";
}

function PastryRequisitionsPage() {
  const reqs = usePastryRequisitions();
  const rows = (reqs.data ?? []) as PastryRow[];
  // Department-side custody confirmation, gated by the bakery's own
  // requisition authority — Stores cannot confirm receipt on its behalf, and
  // this posts no second inventory movement.
  const { can } = useAuth();
  const mayConfirm = can("kitchen", "pastry-requisition", "edit");

  return (
    <div>
      <PageHeader
        eyebrow="Pastry & Bakery"
        title="Requisitions"
        description="Requisitions the Head Pastry Chef has sent to Stores, and where each one now stands."
      />

      <SectionCard title="Sent to Stores" description="Most recent first.">
        <QueryState
          isLoading={reqs.isLoading}
          error={reqs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No requisitions yet"
              description="Consolidate reported stock needs to raise the first one."
            />
          }
        >
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={String(r["id"])}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
              >
                <div>
                  <p className="text-sm font-medium">{pastryStr(r["request_number"])}</p>
                  <p className="text-xs text-muted-foreground">
                    Requested {pastryStr(r["request_date"])}
                    {r["required_date"] ? ` · needed ${pastryStr(r["required_date"])}` : ""} ·{" "}
                    {titleCase(pastryStr(r["priority"], "normal"))}
                  </p>
                  {r["reason"] ? (
                    <p className="mt-1 text-xs text-muted-foreground">{pastryStr(r["reason"])}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={reqTone(String(r["status"]))}>
                    {titleCase(String(r["status"]))}
                  </StatusPill>
                  {mayConfirm && awaitingReceipt(r) ? <ConfirmReceiptButton requisition={r} /> : null}
                </div>
              </div>
            ))}
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

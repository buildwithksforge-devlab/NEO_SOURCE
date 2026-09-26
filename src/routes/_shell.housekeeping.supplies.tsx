import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/operations";
import {
  num,
  str,
  useHousekeepingStockNeeds,
  useReviewHkStockNeed,
  type HkRow,
} from "@/lib/housekeeping-department";

export const Route = createFileRoute("/_shell/housekeeping/supplies")({
  head: () => ({
    meta: [
      { title: "Housekeeping Supplies — NEØ" },
      {
        name: "description",
        content:
          "Supply needs reported by housekeepers, reviewed by the Housekeeping Manager before a Stores requisition is raised.",
      },
      { property: "og:title", content: "Housekeeping Supplies — NEØ" },
      {
        property: "og:description",
        content:
          "Review reported housekeeping supply needs. Stock balances stay owned by Inventory & Stores.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="housekeeping" action="supplies.view">
      <HousekeepingSuppliesPage />
    </OpsGuard>
  ),
});

const NEED_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  pending: "warning",
  acknowledged: "default",
  requisitioned: "success",
  declined: "destructive",
  closed: "default",
};

function HousekeepingSuppliesPage() {
  const { can } = useAuth();
  const mayReview = can("housekeeping", "requisitions.create");

  const needs = useHousekeepingStockNeeds("all");
  const review = useReviewHkStockNeed();

  const rows = (needs.data ?? []) as HkRow[];

  return (
    <div>
      <PageHeader
        eyebrow="Housekeeping"
        title="Supply needs"
        description="Housekeepers report what a floor is short of. The manager reviews each one and decides whether it becomes a Stores requisition."
        actions={
          mayReview ? (
            <Button variant="outline" asChild>
              <Link to="/housekeeping/requisitions">Requisitions to Stores</Link>
            </Button>
          ) : null
        }
      />

      <SectionCard
        title="Reported needs"
        description="Every supply need reported for this property."
      >
        <QueryState
          isLoading={needs.isLoading}
          error={needs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No supply needs reported"
              description="Housekeepers report shortages from their own work screen; they appear here for review."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = str(row["status"], "pending");
                  const open = ["pending", "acknowledged"].includes(status);
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell>
                        <p className="font-medium">{str(row["item"], "Item")}</p>
                        <p className="text-xs text-muted-foreground">
                          {str(row["notes"], "No notes")}
                        </p>
                      </TableCell>
                      <TableCell className="text-right">
                        {num(row["quantity"])} {str(row["unit"], "unit")}
                      </TableCell>
                      <TableCell>{titleCase(str(row["priority"], "normal"))}</TableCell>
                      <TableCell>
                        <StatusPill tone={NEED_TONE[status] ?? "default"}>
                          {titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        {mayReview && open ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={review.isPending}
                              onClick={() =>
                                review.mutate({
                                  needId: String(row["id"]),
                                  decision: "acknowledge",
                                })
                              }
                            >
                              Acknowledge
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={review.isPending}
                              onClick={() =>
                                review.mutate({ needId: String(row["id"]), decision: "decline" })
                              }
                            >
                              Decline
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

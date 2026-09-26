import { createFileRoute } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
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
import { shortDateTime, titleCase } from "@/lib/operations";
import {
  num,
  str,
  useLinenIncidents,
  useReviewLinenIncident,
  type LaundryRow,
} from "@/lib/laundry-department";

export const Route = createFileRoute("/_shell/laundry/incidents")({
  head: () => ({
    meta: [
      { title: "Linen Damage & Loss — Laundry — NEØ" },
      {
        name: "description",
        content:
          "Damaged, stained and missing linen reported from the floor, reviewed by the Laundry Manager.",
      },
      { property: "og:title", content: "Linen Damage & Loss — Laundry — NEØ" },
      {
        property: "og:description",
        content:
          "Linen accountability: every damage or loss report reviewed, with write-offs sent for approval.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="laundry" action="incidents.view">
      <LinenIncidentsPage />
    </OpsGuard>
  ),
});

const TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  reported: "warning",
  "awaiting-approval": "warning",
  repair: "default",
  dismissed: "default",
  "written-off": "destructive",
};

function LinenIncidentsPage() {
  const { can } = useAuth();
  const mayReview = can("laundry", "incidents.approve") || can("laundry", "incidents.edit");

  const incidents = useLinenIncidents("all");
  const review = useReviewLinenIncident();

  const rows = (incidents.data ?? []) as LaundryRow[];
  const openCount = rows.filter((r) => str(r["status"], "") === "reported").length;
  const awaiting = rows.filter((r) => str(r["status"], "") === "awaiting-approval").length;
  const units = rows.reduce((total, r) => total + num(r["quantity"]), 0);

  return (
    <div>
      <PageHeader
        eyebrow="Laundry"
        title="Damage & loss"
        description="Every item that does not come back clean is recorded here. A write-off always goes through approval, never straight off the register."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Awaiting review"
          value={String(openCount)}
          hint="reported, not yet decided"
        />
        <StatCard
          label="Awaiting approval"
          value={String(awaiting)}
          hint="write-offs in the approval queue"
        />
        <StatCard
          label="Units affected"
          value={String(units)}
          hint="all reports on this property"
        />
      </div>

      <SectionCard
        title="Linen incidents"
        description="Reported by laundry, housekeeping or on batch reconciliation."
      >
        <QueryState
          isLoading={incidents.isLoading}
          error={incidents.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No linen incidents"
              description="Damage and loss reports appear here as soon as they are raised."
              icon={ShieldAlert}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Condition</TableHead>
                  <TableHead>Reported</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = str(row["status"], "reported");
                  const open = status === "reported";
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell>
                        <p className="font-medium">
                          {str((row["linen_items"] as LaundryRow | null)?.["name"], "Linen item")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {str(row["reason"], "No detail")}
                        </p>
                      </TableCell>
                      <TableCell className="text-right">{num(row["quantity"])}</TableCell>
                      <TableCell>
                        {titleCase(str(row["condition"], "damaged").replace("-", " "))}
                      </TableCell>
                      <TableCell>{shortDateTime(row["created_at"] as string)}</TableCell>
                      <TableCell>
                        <StatusPill tone={TONE[status] ?? "default"}>
                          {titleCase(status.replace("-", " "))}
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
                                review.mutate({ incidentId: String(row["id"]), decision: "repair" })
                              }
                            >
                              Repair
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={review.isPending}
                              onClick={() =>
                                review.mutate({
                                  incidentId: String(row["id"]),
                                  decision: "dismiss",
                                })
                              }
                            >
                              Dismiss
                            </Button>
                            <Button
                              size="sm"
                              disabled={review.isPending}
                              onClick={() =>
                                review.mutate({
                                  incidentId: String(row["id"]),
                                  decision: "write-off",
                                })
                              }
                            >
                              Send write-off
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {str(row["final_action"], "—")}
                          </span>
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

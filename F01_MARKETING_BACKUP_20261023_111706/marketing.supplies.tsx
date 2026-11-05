import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PackageSearch } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  MKT_SUPPLY_SUGGESTIONS,
  num,
  str,
  useMarketingStockNeeds,
  useReportMarketingStockNeed,
  useReviewMarketingStockNeed,
  type MktRow,
} from "@/lib/marketing-department";

export const Route = createFileRoute("/_shell/marketing/supplies")({
  head: () => ({
    meta: [
      { title: "Marketing Supplies — NEØ" },
      {
        name: "description",
        content:
          "Brochures, banners and branded material requested by the marketing team and reviewed by the Marketing Manager.",
      },
      { property: "og:title", content: "Marketing Supplies — NEØ" },
      {
        property: "og:description",
        content:
          "Report what marketing is short of. Stock and purchasing stay owned by Stores and Procurement.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="marketing" action="stock_needs.view">
      <MarketingSuppliesPage />
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

function MarketingSuppliesPage() {
  const { can } = useAuth();
  const mayReview = can("marketing", "stock_needs.approve");

  const needs = useMarketingStockNeeds("all");
  const report = useReportMarketingStockNeed();
  const review = useReviewMarketingStockNeed();

  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");

  const rows = (needs.data ?? []) as MktRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Marketing"
        title="Supply needs"
        description="The team reports what it is short of. The Marketing Manager decides whether it becomes a Stores requisition — nobody here raises one directly."
      />

      <SectionCard
        title="Report a need"
        description={`Common items: ${MKT_SUPPLY_SUGGESTIONS.join(", ")}.`}
      >
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="need-item">Item</Label>
            <Input
              id="need-item"
              value={item}
              onChange={(e) => setItem(e.target.value)}
              placeholder="Roll-up banners for the expo stand"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="need-qty">Quantity</Label>
            <Input
              id="need-qty"
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={!item.trim() || report.isPending}
              onClick={() =>
                report.mutate(
                  { item, quantity: Number(quantity) || 1, notes },
                  {
                    onSuccess: () => {
                      setItem("");
                      setQuantity("1");
                      setNotes("");
                    },
                  },
                )
              }
            >
              Report need
            </Button>
          </div>
          <div className="space-y-1.5 md:col-span-4">
            <Label htmlFor="need-notes">Notes</Label>
            <Input
              id="need-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Needed before the trade show on the 14th"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Reported needs"
        description="Every marketing supply need for this property."
      >
        <QueryState
          isLoading={needs.isLoading}
          error={needs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No supply needs reported"
              description="Report a shortage and it appears here for the Marketing Manager to review."
              icon={PackageSearch}
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

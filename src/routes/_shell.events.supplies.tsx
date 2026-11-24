import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PackageSearch } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
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
import { useBookings } from "@/lib/events-data";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { titleCase } from "@/lib/operations";
import {
  BANQUET_SUPPLY_SUGGESTIONS,
  sevNum,
  sevStr,
  useEventStockNeeds,
  useReportEventStockNeed,
  useReviewEventStockNeed,
  type SevRow,
} from "@/lib/sales-events-department";

export const Route = createFileRoute("/_shell/events/supplies")({
  head: () => ({
    meta: [
      { title: "Event Supplies — NEØ" },
      {
        name: "description",
        content:
          "Linen, glassware and setup materials the banqueting team is short of, reviewed by the Sales & Events Manager.",
      },
      { property: "og:title", content: "Event Supplies — NEØ" },
      {
        property: "og:description",
        content:
          "Report what the floor needs. Only the manager turns a need into a Stores requisition.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="events" action="stock_needs.view">
      <EventSuppliesPage />
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

function EventSuppliesPage() {
  const { can } = useAuth();
  const mayReview = can("events", "stock_needs.approve");

  const bookings = useBookings();
  const [bookingId, setBookingId] = useState("");
  const needs = useEventStockNeeds("all");
  const report = useReportEventStockNeed();
  const review = useReviewEventStockNeed();

  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");

  const rows = (needs.data ?? []) as SevRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sales, Events & Banqueting"
        title="Event supply needs"
        description="Banqueting reports what is short. The Sales & Events Manager decides whether it becomes a Stores requisition — nobody on the floor raises one directly."
      />

      <SectionCard
        title="Report a need"
        description={`Common items: ${BANQUET_SUPPLY_SUGGESTIONS.join(", ")}.`}
      >
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5 md:col-span-4">
            <Label>Event booking</Label>
            <Select value={bookingId} onValueChange={setBookingId}>
              <SelectTrigger>
                <SelectValue placeholder="Select the event requiring supplies" />
              </SelectTrigger>
              <SelectContent>
                {((bookings.data ?? []) as SevRow[])
                  .filter((event) =>
                    !["cancelled", "closed"].includes(
                      sevStr(event["status"], "")
                    )
                  )
                  .map((event) => (
                    <SelectItem
                      key={sevStr(event["id"], "")}
                      value={sevStr(event["id"], "")}
                    >
                      {sevStr(
                        event["event_name"],
                        sevStr(event["event_reference"], "Event")
                      )} - {sevStr(event["event_date"], "")}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="need-item">Item</Label>
            <Input
              id="need-item"
              value={item}
              onChange={(e) => setItem(e.target.value)}
              placeholder="Chair covers for the main hall"
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
              disabled={!bookingId || !item.trim() || report.isPending}
              onClick={() =>
                report.mutate(
                  { bookingId, item, quantity: Number(quantity) || 1, notes },
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
              placeholder="Needed before Saturday's wedding setup"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Reported needs"
        description="Everything the department has raised, with the decision made."
      >
        <QueryState isLoading={needs.isLoading} error={needs.error} isEmpty={false} empty={null}>
          {rows.length === 0 ? (
            <EmptyState
              icon={PackageSearch}
              title="Nothing reported"
              description="No outstanding supply needs."
            />
          ) : (
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="text-right">Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((n) => {
                    const id = sevStr(n["id"], "");
                    const status = sevStr(n["status"], "pending");
                    return (
                      <TableRow key={id}>
                        <TableCell className="font-medium">{sevStr(n["item"])}</TableCell>
                        <TableCell className="text-right">
                          {sevNum(n["quantity"])} {sevStr(n["unit"], "")}
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={NEED_TONE[status] ?? "default"}>
                            {titleCase(status)}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="max-w-[280px] truncate">
                          {sevStr(n["notes"])}
                        </TableCell>
                        <TableCell className="space-x-2 text-right">
                          {mayReview && status === "pending" ? (
                            <>
                              <Button
                                size="sm"
                                disabled={review.isPending}
                                onClick={() =>
                                  review.mutate({ needId: id, decision: "requisition" })
                                }
                              >
                                Requisition
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={review.isPending}
                                onClick={() => review.mutate({ needId: id, decision: "decline" })}
                              >
                                Decline
                              </Button>
                            </>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
          )}
        </QueryState>
      </SectionCard>
    </div>
  );
}

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { titleCase } from "@/lib/operations";
import {
  HR_SUPPLY_SUGGESTIONS,
  str,
  useHrStockNeeds,
  useReportHrStockNeed,
  type HrRow,
} from "@/lib/hr-department";

export const Route = createFileRoute("/_shell/hr/supplies")({
  head: () => ({
    meta: [
      { title: "HR Office Supplies — NEØ" },
      {
        name: "description",
        content:
          "HR requests its own office consumables from Stores and follows each request through to issue.",
      },
      { property: "og:title", content: "HR Office Supplies — NEØ" },
      {
        property: "og:description",
        content:
          "Stationery, personnel files and printing supplies requested from Stores by the HR office.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="human-resources" action="view">
      <HrSuppliesPage />
    </OpsGuard>
  ),
});

const STATUS_TONE: Record<string, "default" | "success" | "warning" | "info" | "destructive"> = {
  pending: "warning",
  approved: "info",
  issued: "success",
  fulfilled: "success",
  rejected: "destructive",
};

function HrSuppliesPage() {
  const needs = useHrStockNeeds("all");
  const report = useReportHrStockNeed();

  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("unit");
  const [notes, setNotes] = useState("");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="HR office supplies"
        description="HR does not hold stock. Office consumables are requested from Stores and issued against this request."
      />

      <SectionCard
        title="Request a supply"
        description="Stores reviews and issues; the request stays visible until it is fulfilled."
      >
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="hr-item">Item</Label>
            <Input
              id="hr-item"
              list="hr-supply-suggestions"
              value={item}
              onChange={(e) => setItem(e.target.value)}
              placeholder="Personnel files"
            />
            <datalist id="hr-supply-suggestions">
              {HR_SUPPLY_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hr-qty">Quantity</Label>
            <Input
              id="hr-qty"
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hr-unit">Unit</Label>
            <Input id="hr-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-3">
            <Label htmlFor="hr-notes">Notes</Label>
            <Textarea
              id="hr-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={!item.trim() || report.isPending}
              onClick={() =>
                report.mutate(
                  { item: item.trim(), quantity: Number(quantity) || 1, unit, notes },
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
              Send to Stores
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Requests" description="Every HR supply request and where it stands.">
        <QueryState
          isLoading={needs.isLoading}
          error={needs.error}
          isEmpty={(needs.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No supply requests"
              description="Requests HR sends to Stores appear here with their status."
              icon={Package}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Raised</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {((needs.data ?? []) as HrRow[]).map((row) => {
                  const status = str(row["status"], "pending");
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell className="text-sm text-muted-foreground">
                        {String(row["created_at"] ?? "").slice(0, 10)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {str(row["item_name"] ?? row["item"])}
                      </TableCell>
                      <TableCell>
                        {str(row["quantity"], "0")} {str(row["unit"], "")}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={STATUS_TONE[status] ?? "default"}>
                          {titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="max-w-[18rem] text-sm text-muted-foreground">
                        {str(row["notes"])}
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

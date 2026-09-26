/**
 * Weekly stores report.
 *
 * Item group → category → stock item, with each property's own balance,
 * reorder alerts and the purchase requests already in flight. Everything is
 * read from `neo_inventory_weekly_report`, which sums the stock ledger for
 * real; nothing on this page is estimated. The report can be downloaded as a
 * spreadsheet file and sent to Procurement as an in-app alert — outbound email
 * waits until a mail provider is connected.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Boxes, Download, PackageSearch, Send } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { OpsGuard } from "@/components/operations/OpsShared";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useWeeklyStockReport } from "@/lib/inventory-data";
import { formatQuantity, num, type Row } from "@/lib/inventory";

export const Route = createFileRoute("/_shell/inventory/weekly-report")({
  head: () => ({
    meta: [
      { title: "Weekly Stores Report — NEØ" },
      {
        name: "description",
        content:
          "Every item group, category and stock item with its balance per property, reorder alerts and purchase requests already in flight.",
      },
      { property: "og:title", content: "Weekly Stores Report — NEØ" },
      {
        property: "og:description",
        content: "Stock on hand, reorder alerts and pending purchase requests, ready to download or send to Procurement.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/inventory/weekly-report">
      <WeeklyReportPage />
    </OpsGuard>
  ),
});

type ReportRow = {
  groupName: string;
  categoryName: string;
  itemId: string;
  itemName: string;
  sku: string;
  unit: string;
  branchId: string | null;
  branchName: string;
  onHand: number;
  reorder: number | null;
  par: number | null;
  belowReorder: boolean;
  pendingQty: number;
  pendingCount: number;
};

function toRow(raw: Row): ReportRow {
  return {
    groupName: String(raw["group_name"] ?? "No item group"),
    categoryName: String(raw["category_name"] ?? "Not categorised"),
    itemId: String(raw["item_id"]),
    itemName: String(raw["item_name"] ?? "Unnamed"),
    sku: String(raw["sku"] ?? ""),
    unit: String(raw["base_unit"] ?? ""),
    branchId: (raw["branch_id"] as string | null) ?? null,
    branchName: String(raw["branch_name"] ?? "—"),
    onHand: num(raw["on_hand"]),
    reorder: raw["reorder_point"] === null || raw["reorder_point"] === undefined ? null : num(raw["reorder_point"]),
    par: raw["par_level"] === null || raw["par_level"] === undefined ? null : num(raw["par_level"]),
    belowReorder: raw["below_reorder"] === true,
    pendingQty: num(raw["pending_request_quantity"]),
    pendingCount: num(raw["pending_request_count"]),
  };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function WeeklyReportPage() {
  const { can } = useAuth();
  // Undefined asks for the active property; null deliberately asks for every
  // property, so the totals can sit side by side.
  const [allProperties, setAllProperties] = useState(false);
  const report = useWeeklyStockReport(allProperties ? null : undefined);
  const [sending, setSending] = useState(false);

  const rows = useMemo(() => ((report.data ?? []) as Row[]).map(toRow), [report.data]);

  const alerts = rows.filter((r) => r.belowReorder);
  const pending = rows.filter((r) => r.pendingCount > 0);
  const properties = new Set(rows.map((r) => r.branchName));

  const byProperty = useMemo(() => {
    const totals = new Map<string, { items: number; alerts: number; pending: number }>();
    for (const row of rows) {
      const entry = totals.get(row.branchName) ?? { items: 0, alerts: 0, pending: 0 };
      entry.items += 1;
      if (row.belowReorder) entry.alerts += 1;
      if (row.pendingCount > 0) entry.pending += row.pendingCount;
      totals.set(row.branchName, entry);
    }
    return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Map<string, ReportRow[]>>();
    for (const row of rows) {
      const categories = groups.get(row.groupName) ?? new Map<string, ReportRow[]>();
      const list = categories.get(row.categoryName) ?? [];
      list.push(row);
      categories.set(row.categoryName, list);
      groups.set(row.groupName, categories);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  function download() {
    const header = [
      "Item group",
      "Category",
      "Item",
      "Code",
      "Unit",
      "Property",
      "On hand",
      "Reorder point",
      "Par level",
      "Below reorder",
      "Requested quantity",
      "Open requests",
    ];
    const body = rows.map((r) =>
      [
        r.groupName,
        r.categoryName,
        r.itemName,
        r.sku,
        r.unit,
        r.branchName,
        r.onHand,
        r.reorder ?? "",
        r.par ?? "",
        r.belowReorder ? "Yes" : "No",
        r.pendingQty,
        r.pendingCount,
      ].map(csvCell).join(","),
    );
    const blob = new Blob([[header.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `weekly-stores-report-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function sendToProcurement() {
    setSending(true);
    try {
      const day = new Date().toISOString().slice(0, 10);
      const { error } = await guardedRpc(supabase, "notify_recipients", {
        _category: "stock",
        _title: `Weekly stores report — ${alerts.length} item${alerts.length === 1 ? "" : "s"} below reorder`,
        _body: `${rows.length} stock items reviewed across ${properties.size} propert${properties.size === 1 ? "y" : "ies"}. ${alerts.length} below reorder, ${pending.length} already on a purchase request.`,
        _link: "/inventory/weekly-report",
        _priority: alerts.length > 0 ? "high" : "normal",
        _role_names: ["Procurement Officer", "Procurement Manager", "Store Keeper"],
        _idem: `weekly-stores-report:${day}:${allProperties ? "all" : "active"}`,
      });
      if (error) throw error;
      toast.success("Sent to Procurement");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the report");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Weekly stores report"
        description="Every item group, category and stock item with its balance per property, what has fallen below its reorder point, and what Procurement is already handling."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch id="all-properties" checked={allProperties} onCheckedChange={setAllProperties} />
              <Label htmlFor="all-properties" className="text-sm">All properties</Label>
            </div>
            <Button variant="outline" onClick={download} disabled={rows.length === 0}>
              <Download className="mr-2 size-4" /> Download
            </Button>
            {can("procurement", "requests", "view") ? (
              <Button onClick={sendToProcurement} disabled={sending || rows.length === 0}>
                <Send className="mr-2 size-4" /> Send to Procurement
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Stock items" value={String(rows.length)} icon={Boxes} />
        <StatCard label="Below reorder" value={String(alerts.length)} icon={AlertTriangle} tone={alerts.length > 0 ? "warning" : "default"} />
        <StatCard label="On a purchase request" value={String(pending.length)} icon={PackageSearch} />
        <StatCard label="Properties covered" value={String(properties.size)} icon={Boxes} />
      </div>

      <QueryState
        query={report}
        isLoading={report.isLoading}
        error={report.error}
        isEmpty={rows.length === 0}
        empty="No stock items are mapped yet."
      >
        <div className="space-y-6">
          {byProperty.length > 1 ? (
            <SectionCard title="By property" description="Each property keeps its own balances, reorder rules and requests.">
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Property</TableHead>
                      <TableHead className="text-right">Items</TableHead>
                      <TableHead className="text-right">Below reorder</TableHead>
                      <TableHead className="text-right">Open requests</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {byProperty.map(([name, totals]) => (
                      <TableRow key={name}>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell className="text-right tabular-nums">{totals.items}</TableCell>
                        <TableCell className="text-right tabular-nums">{totals.alerts}</TableCell>
                        <TableCell className="text-right tabular-nums">{totals.pending}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </SectionCard>
          ) : null}

          {alerts.length > 0 ? (
            <SectionCard
              title="Needs attention"
              description="Below the reorder point for that property."
              actions={
                <Button asChild variant="outline" size="sm">
                  <Link to="/procurement/requests">Open Procurement</Link>
                </Button>
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>Property</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="text-right">Reorder at</TableHead>
                      <TableHead className="text-right">Requested</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {alerts.map((row) => (
                      <TableRow key={`${row.itemId}-${row.branchId ?? "org"}`}>
                        <TableCell>
                          <div className="font-medium">{row.itemName}</div>
                          <div className="text-xs text-muted-foreground">
                            {row.groupName} · {row.categoryName}
                          </div>
                        </TableCell>
                        <TableCell>{row.branchName}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatQuantity(row.onHand)} {row.unit}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.reorder === null ? "—" : formatQuantity(row.reorder)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.pendingCount > 0 ? `${formatQuantity(row.pendingQty)} (${row.pendingCount})` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </SectionCard>
          ) : null}

          {grouped.map(([groupName, categories]) => (
            <SectionCard key={groupName} title={groupName} description={`${categories.size} categor${categories.size === 1 ? "y" : "ies"}`}>
              <div className="space-y-5">
                {[...categories.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([categoryName, list]) => (
                  <div key={categoryName} className="space-y-2">
                    <div className="text-sm font-medium text-muted-foreground">{categoryName}</div>
                    <TableScroll>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Item</TableHead>
                            <TableHead>Property</TableHead>
                            <TableHead className="text-right">On hand</TableHead>
                            <TableHead className="text-right">Reorder / par</TableHead>
                            <TableHead className="text-right">Requested</TableHead>
                            <TableHead className="text-right">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {list.map((row) => (
                            <TableRow key={`${row.itemId}-${row.branchId ?? "org"}`}>
                              <TableCell>
                                <div className="font-medium">{row.itemName}</div>
                                {row.sku ? <div className="text-xs text-muted-foreground">{row.sku}</div> : null}
                              </TableCell>
                              <TableCell>{row.branchName}</TableCell>
                              <TableCell className="text-right tabular-nums">{formatQuantity(row.onHand)} {row.unit}</TableCell>
                              <TableCell className="text-right tabular-nums">
                                {row.reorder === null ? "—" : formatQuantity(row.reorder)} / {row.par === null ? "—" : formatQuantity(row.par)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {row.pendingCount > 0 ? formatQuantity(row.pendingQty) : "—"}
                              </TableCell>
                              <TableCell className="text-right">
                                <StatusPill tone={row.belowReorder ? "warning" : row.reorder === null ? "default" : "success"}>
                                  {row.belowReorder ? "Below reorder" : row.reorder === null ? "No rule set" : "In stock"}
                                </StatusPill>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableScroll>
                  </div>
                ))}
              </div>
            </SectionCard>
          ))}
        </div>
      </QueryState>
    </div>
  );
}

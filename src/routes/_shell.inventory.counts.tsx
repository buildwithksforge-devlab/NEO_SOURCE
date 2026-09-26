import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useStockLocations } from "@/lib/inventory-data";
import {
  num,
  str,
  useRecordCountedQuantity,
  useStartStockCount,
  useStockTakeLines,
  useStoresAdjustments,
  useStoresStockTakes,
  useSubmitCountVariance,
  useReconcileCountAgainstLedger,
  useDecideStockAdjustment,
  type StoresRow,
} from "@/lib/stores-department";

export const Route = createFileRoute("/_shell/inventory/counts")({
  head: () => ({
    meta: [
      { title: "Stock counts and variances — NEØ" },
      {
        name: "description",
        content:
          "Open a count, record the physical quantities and send every difference for approval — counted stock never overwrites the ledger silently.",
      },
      { property: "og:title", content: "Stock counts and variances — NEØ" },
      {
        property: "og:description",
        content:
          "Controlled stock counting: count, investigate the variance, then approve the adjustment.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="stores" action="counts.view">
      <StockCountsPage />
    </OpsGuard>
  ),
});

const COUNT_TYPES = ["full", "cycle", "spot"] as const;

const FLAG_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  match: "success",
  shortage: "destructive",
  overage: "warning",
  "not-counted": "default",
};

const TAKE_TONE: Record<string, "success" | "warning" | "info" | "default"> = {
  "in-progress": "info",
  "awaiting-approval": "warning",
  closed: "success",
};

/** A figure is only a count if it is a number and not below zero. */
function countIsInvalid(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const value = Number(trimmed);
  return !Number.isFinite(value) || value < 0;
}

function CountLines({
  takeId,
  mayCount,
  onValidityChange,
}: {
  takeId: string;
  mayCount: boolean;
  onValidityChange?: (hasInvalid: boolean) => void;
}) {

  const lines = useStockTakeLines(takeId);
  const record = useRecordCountedQuantity();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const rows = (lines.data ?? []) as StoresRow[];
  const hasInvalid = Object.values(drafts).some((raw) => countIsInvalid(raw));

  // The page needs to know straight away, so closing is blocked while a figure
  // is impossible and allowed again the moment it is corrected.
  useEffect(() => {
    onValidityChange?.(hasInvalid);
  }, [hasInvalid, onValidityChange]);


  return (
    <QueryState
      isLoading={lines.isLoading}
      error={lines.error}
      isEmpty={rows.length === 0}
      empty={<p className="py-6 text-sm text-muted-foreground">This count has no lines.</p>}
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">System</TableHead>
              <TableHead className="text-right">Counted</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="text-right">Ledger now</TableHead>
              <TableHead>Discrepancy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const id = String(row["id"]);
              const system = num(row["system_quantity"]);
              const counted =
                row["counted_quantity"] === null ? null : num(row["counted_quantity"]);
              const variance = counted === null ? null : counted - system;
              return (
                <TableRow key={id}>
                  <TableCell className="font-medium">
                    {str((row["stock_items"] as StoresRow | null)?.["name"], "Item")}
                  </TableCell>
                  <TableCell className="text-right">
                    {system} {str(row["unit"], "")}
                  </TableCell>
                  <TableCell className="text-right">
                    {mayCount ? (
                      <div className="flex flex-col items-end gap-1">
                        <Input
                          className="ml-auto h-8 w-28 text-right"
                          inputMode="decimal"
                          aria-invalid={countIsInvalid(drafts[id])}
                          value={drafts[id] ?? (counted === null ? "" : String(counted))}
                          onChange={(e) => setDrafts((prev) => ({ ...prev, [id]: e.target.value }))}
                          onBlur={(e) => {
                            const value = Number(e.target.value);
                            if (
                              e.target.value !== "" &&
                              Number.isFinite(value) &&
                              value >= 0 &&
                              value !== counted
                            ) {
                              record.mutate({
                                lineId: id,
                                counted: value,
                                unit: str(row["unit"], ""),
                              });
                            }
                          }}
                        />
                        {/* A shelf cannot hold less than nothing: say so here rather
                            than letting the count be closed on an impossible figure.
                            The wording disappears the moment the figure is corrected. */}
                        {countIsInvalid(drafts[id]) ? (
                          <span className="text-xs text-destructive">
                            A counted quantity must be zero or more.
                          </span>

                        ) : record.isPending && record.variables?.lineId === id ? (
                          <span className="text-xs text-muted-foreground">Saving…</span>
                        ) : null}
                      </div>
                    ) : counted === null ? (
                      "—"
                    ) : (
                      counted
                    )}
                  </TableCell>
                  <TableCell
                    className={`text-right ${variance !== null && variance !== 0 ? "text-destructive" : ""}`}
                  >
                    {variance === null ? "—" : variance > 0 ? `+${variance}` : variance}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {row["ledger_quantity"] === null || row["ledger_quantity"] === undefined
                      ? "—"
                      : num(row["ledger_quantity"])}
                  </TableCell>
                  <TableCell>
                    {row["discrepancy_flag"] ? (
                      <StatusPill tone={FLAG_TONE[str(row["discrepancy_flag"], "")] ?? "default"}>
                        {titleCase(str(row["discrepancy_flag"], ""))}
                        {row["ledger_variance"] === null || row["ledger_variance"] === undefined
                          ? ""
                          : ` ${num(row["ledger_variance"]) > 0 ? "+" : ""}${num(row["ledger_variance"])}`}
                      </StatusPill>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not reconciled</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </QueryState>
  );
}

/** Whole days a count has been open, or null when no start time is recorded. */
function ageDays(row: StoresRow): number | null {
  const raw = row["started_at"] ?? row["created_at"];
  if (!raw) return null;
  const started = new Date(String(raw)).getTime();
  if (!Number.isFinite(started)) return null;
  return Math.floor((Date.now() - started) / 86_400_000);
}

export function StockCountsPage() {
  const { can } = useAuth();
  const mayCount = can("stores", "counts.edit");

  const locations = useStockLocations();
  const takes = useStoresStockTakes();
  const adjustments = useStoresAdjustments("pending");
  const start = useStartStockCount();
  const submit = useSubmitCountVariance();
  const reconcile = useReconcileCountAgainstLedger();
  const decide = useDecideStockAdjustment();
  const mayApprove = can("inventory", "adjustments.approve");
  const [declineNote, setDeclineNote] = useState<Record<string, string>>({});

  const [locationId, setLocationId] = useState("");
  const [countType, setCountType] = useState<string>("cycle");
  const [openTakeId, setOpenTakeId] = useState<string | null>(null);
  const [varianceNotes, setVarianceNotes] = useState("");
  const [hasInvalidLine, setHasInvalidLine] = useState(false);
  const handleValidity = useCallback((invalid: boolean) => setHasInvalidLine(invalid), []);


  const locationRows = (locations.data ?? []) as StoresRow[];
  const takeRows = (takes.data ?? []) as StoresRow[];
  const adjustmentRows = (adjustments.data ?? []) as StoresRow[];
  // One count at a time per store: a second one would be counted against
  // quantities the first has already frozen.
  const openCountHere = takeRows.find(
    (row) =>
      str(row["status"], "") === "in-progress" && String(row["location_id"] ?? "") === locationId,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Inventory & Stores"
        title="Stock counts and variances"
        description="A count never rewrites the ledger. Differences are investigated, then raised as a stock adjustment for somebody else to approve."
      />

      {mayCount ? (
        <SectionCard
          title="Open a count"
          description="Snapshot the system quantities for a store, then count against them."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Store</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a store" />
                </SelectTrigger>
                <SelectContent>
                  {locationRows.map((row) => (
                    <SelectItem key={String(row["id"])} value={String(row["id"])}>
                      {str(row["name"], "Store")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Count type</Label>
              <Select value={countType} onValueChange={setCountType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COUNT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {titleCase(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col items-stretch justify-end gap-1">
              <Button
                className="w-full"
                disabled={!locationId || start.isPending || Boolean(openCountHere)}
                onClick={() =>
                  start.mutate({ locationId, countType }, { onSuccess: (id) => setOpenTakeId(id) })
                }
              >
                {start.isPending ? "Opening count…" : "Open count"}
              </Button>
              {openCountHere ? (
                <span className="text-xs text-muted-foreground">
                  {str(openCountHere["reference"], "A count")} is still open for this store. Finish
                  it before opening another.
                </span>
              ) : null}
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Counts" description="Recent counts for this property.">
        <QueryState
          isLoading={takes.isLoading}
          error={takes.error}
          isEmpty={takeRows.length === 0}
          empty={
            <EmptyState
              icon={ClipboardCheck}
              title="No counts yet"
              description="Open a count to begin."
            />
          }
        >
          <div className="space-y-3">
            {takeRows.map((row) => {
              const id = String(row["id"]);
              const status = str(row["status"], "in-progress");
              const open = openTakeId === id;
              return (
                <div key={id} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{str(row["reference"], "Count")}</p>
                      <p className="text-xs text-muted-foreground">
                        {str((row["stock_locations"] as StoresRow | null)?.["name"], "Store")} ·{" "}
                        {titleCase(str(row["count_type"], "cycle"))} count
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill tone={TAKE_TONE[status] ?? "default"}>
                        {titleCase(status)}
                      </StatusPill>
                      <DocumentPrintButton type="stock_sheet" id={id} label="Stock sheet" />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setOpenTakeId(open ? null : id)}
                      >
                        {open ? "Hide" : "Open"}
                      </Button>
                    </div>
                  </div>

                  {status === "in-progress" && ageDays(row) !== null && ageDays(row)! >= 2 ? (
                    <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                      Open for {ageDays(row)} days. A count this old should be finished or
                      abandoned — its system quantities were frozen when it was opened and no longer
                      match today&apos;s stock.
                    </p>
                  ) : null}

                  {open ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-xs text-muted-foreground">
                        &ldquo;System&rdquo; is the quantity frozen when this count was opened. Later
                        issues and receipts deliberately do not change it, so the variance reflects
                        what was on the shelf at counting time.
                      </p>
                      <CountLines
                        takeId={id}
                        mayCount={mayCount && status === "in-progress"}
                        onValidityChange={handleValidity}
                      />
                      {mayCount && status === "in-progress" ? (
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={reconcile.isPending}
                              onClick={() => reconcile.mutate(id)}
                            >
                              {reconcile.isPending
                                ? "Comparing…"
                                : "Reconcile against the ledger"}
                            </Button>
                            <span className="text-xs text-muted-foreground">
                              Compares each counted line with today&apos;s ledger balance and flags
                              every shortage or overage. Stock is not changed.
                            </span>
                          </div>
                          <Textarea
                            rows={2}
                            placeholder="Investigation notes for any difference found"
                            value={varianceNotes}
                            onChange={(e) => setVarianceNotes(e.target.value)}
                          />
                          <Button
                            disabled={submit.isPending || hasInvalidLine}
                            onClick={() => submit.mutate({ takeId: id, notes: varianceNotes })}
                          >
                            {submit.isPending
                              ? "Closing count…"
                              : "Close counting and send variances for approval"}
                          </Button>
                          {hasInvalidLine ? (
                            <p className="text-xs text-destructive">
                              Correct the highlighted count before closing.
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Adjustments awaiting approval"
        description="No self-approval: whoever raised an adjustment cannot be the one who approves it."
      >
        <QueryState
          isLoading={adjustments.isLoading}
          error={adjustments.error}
          isEmpty={adjustmentRows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">Nothing is waiting for approval.</p>
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Adjustment</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  {mayApprove ? <TableHead>Decision</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {adjustmentRows.map((row) => (
                  <TableRow key={String(row["id"])}>
                    <TableCell className="font-medium">
                      {str(row["adjustment_number"], "Adjustment")}
                    </TableCell>
                    <TableCell>
                      {str((row["stock_locations"] as StoresRow | null)?.["name"], "—")}
                    </TableCell>
                    <TableCell>{titleCase(str(row["reason"], "adjustment"))}</TableCell>
                    <TableCell className="text-right">
                      {((row["stock_adjustment_lines"] ?? []) as StoresRow[]).length}
                    </TableCell>
                    {mayApprove ? (
                      <TableCell>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <Input
                            className="h-8 w-48"
                            placeholder="Reason (required to decline)"
                            value={declineNote[String(row["id"])] ?? ""}
                            onChange={(e) =>
                              setDeclineNote((prev) => ({
                                ...prev,
                                [String(row["id"])]: e.target.value,
                              }))
                            }
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={decide.isPending}
                              onClick={() =>
                                decide.mutate({
                                  adjustmentId: String(row["id"]),
                                  decision: "approve",
                                  notes: declineNote[String(row["id"])] || null,
                                })
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                decide.isPending || !(declineNote[String(row["id"])] ?? "").trim()
                              }
                              onClick={() =>
                                decide.mutate({
                                  adjustmentId: String(row["id"]),
                                  decision: "reject",
                                  notes: declineNote[String(row["id"])] ?? null,
                                })
                              }
                            >
                              Decline
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

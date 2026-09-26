import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { ArrowLeftRight } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDepartmentsLite } from "@/lib/operations-data";
import { useStockItems, useStockLocations, useStockMovements } from "@/lib/inventory-data";
import { titleCase, type Row } from "@/lib/inventory";
import { newAttemptKey, useStoreIssue, type IssueLineInput } from "@/lib/stores-lifecycle";
import {
  RequisitionWorkspace,
  InspectorSection,
  InspectorField,
  type RequisitionRow,
} from "@/components/common/RequisitionWorkspace";
import { useStoresRequisitions, str as storesStr, type StoresRow } from "@/lib/stores-department";
import { BottleUsageCard } from "@/components/inventory/BottleUsageCard";

export const Route = createFileRoute("/_shell/inventory/issues")({
  head: () => ({
    meta: [
      { title: "Store issues and returns — NEØ" },
      {
        name: "description",
        content:
          "Issue stock to a department or take a return back into the store, with every movement written to the ledger once.",
      },
      { property: "og:title", content: "Store issues and returns — NEØ" },
      {
        property: "og:description",
        content:
          "Issue stock to a department or take a return back into the store, with every movement written to the ledger once.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Draft = { stockItemId: string; quantity: string };

function Page() {
  const locations = useStockLocations();
  const items = useStockItems();
  const departments = useDepartmentsLite();
  const movements = useStockMovements(30);
  const post = useStoreIssue();
  const openRequisitions = useStoresRequisitions("open");
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);

  const [direction, setDirection] = useState<"issue" | "return">("issue");
  const [locationId, setLocationId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [reason, setReason] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([{ stockItemId: "", quantity: "" }]);
  const [attemptKey, setAttemptKey] = useState(newAttemptKey);

  const locationRows = (locations.data ?? []) as Row[];
  const itemRows = (items.data ?? []) as Row[];
  const departmentRows = (departments.data ?? []) as Row[];
  const movementRows = (movements.data ?? []) as Row[];

  const lines: IssueLineInput[] = drafts
    .filter((d) => d.stockItemId && Number(d.quantity) > 0)
    .map((d) => ({ stock_item_id: d.stockItemId, quantity: Number(d.quantity) }));

  function submit() {
    post.mutate(
      {
        locationId,
        lines,
        attemptKey,
        departmentId: departmentId || null,
        reason: reason.trim(),
        direction,
      },
      {
        onSuccess: () => {
          setDrafts([{ stockItemId: "", quantity: "" }]);
          setReason("");
          setAttemptKey(newAttemptKey());
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supply Chain"
        title="Store issues and returns"
        description="Stock leaving the store for a department, or coming back unused. Each submission posts once — a repeated click replays the same result instead of moving stock twice."
      />

      <SectionCard
        title="Record a movement"
        description="Choose the store, the items and why the stock is moving."
      >
        <div className="space-y-4">
          <Tabs value={direction} onValueChange={(v) => setDirection(v as "issue" | "return")}>
            <TabsList>
              <TabsTrigger value="issue">Issue out</TabsTrigger>
              <TabsTrigger value="return">Return in</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Store</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Which store?" />
                </SelectTrigger>
                <SelectContent>
                  {locationRows.map((l) => (
                    <SelectItem key={String(l["id"])} value={String(l["id"])}>
                      {String(l["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Receiving department" />
                </SelectTrigger>
                <SelectContent>
                  {departmentRows.map((d) => (
                    <SelectItem key={String(d["id"])} value={String(d["id"])}>
                      {String(d["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            {drafts.map((d, i) => (
              <div key={`line-${i}`} className="flex flex-wrap items-end gap-3">
                <div className="min-w-56 flex-1 space-y-2">
                  <Label>Item</Label>
                  <Select
                    value={d.stockItemId}
                    onValueChange={(v) =>
                      setDrafts((rows) =>
                        rows.map((r, idx) => (idx === i ? { ...r, stockItemId: v } : r)),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Stock item" />
                    </SelectTrigger>
                    <SelectContent>
                      {itemRows.map((it) => (
                        <SelectItem key={String(it["id"])} value={String(it["id"])}>
                          {String(it["name"])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32 space-y-2">
                  <Label htmlFor={`qty-${i}`}>Quantity</Label>
                  <Input
                    id={`qty-${i}`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={d.quantity}
                    onChange={(e) =>
                      setDrafts((rows) =>
                        rows.map((r, idx) => (idx === i ? { ...r, quantity: e.target.value } : r)),
                      )
                    }
                  />
                </div>
                {drafts.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDrafts((rows) => rows.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDrafts((rows) => [...rows, { stockItemId: "", quantity: "" }])}
            >
              Add another item
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="movement-reason">Reason</Label>
            <Textarea
              id="movement-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                direction === "issue"
                  ? "Kitchen production, bar top-up, event set-up…"
                  : "Unused after service, wrong item, over-issued…"
              }
            />
          </div>

          <div className="flex justify-end">
            <Button
              disabled={
                !locationId || lines.length === 0 || reason.trim().length === 0 || post.isPending
              }
              onClick={submit}
            >
              {direction === "issue" ? "Issue stock" : "Return stock"}
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Open department requisitions"
        description="Requests awaiting issue, shown the same way here as on the Department requests queue."
      >
        <RequisitionWorkspace
          lead={{
            id: "open",
            label: "Open requisitions",
            value: openRequisitions.isLoading ? "\u2026" : ((openRequisitions.data ?? []) as StoresRow[]).length,
          }}
          isLoading={openRequisitions.isLoading}
          error={openRequisitions.error}
          rows={((openRequisitions.data ?? []) as StoresRow[]).map((r) => ({
            id: String(r["id"]),
            title: storesStr(r["request_number"], "Requisition"),
            subtitle: `${storesStr((r["departments"] as StoresRow | null)?.["name"], "Department")} \u00b7 ${titleCase(storesStr(r["priority"], "normal"))} priority`,
          }) satisfies RequisitionRow)}
          emptyState={
            <p className="py-6 text-sm text-muted-foreground">Nothing is waiting to be issued.</p>
          }
          selectedId={selectedReqId}
          onSelect={setSelectedReqId}
          renderInspector={(id) => {
            const rows = (openRequisitions.data ?? []) as StoresRow[];
            const r = rows.find((row) => String(row["id"]) === id);
            if (!r) return null;
            return {
              title: storesStr(r["request_number"], "Requisition"),
              subtitle: storesStr((r["departments"] as StoresRow | null)?.["name"], "Department"),
              sections: (
                <InspectorSection title="Request">
                  <InspectorField label="Priority">
                    {titleCase(storesStr(r["priority"], "normal"))}
                  </InspectorField>
                  <InspectorField label="Reason">{storesStr(r["reason"], "\u2014")}</InspectorField>
                </InspectorSection>
              ),
              footer: (
                <Button asChild size="sm">
                  <a href="/inventory/requisitions">Issue in Department requests</a>
                </Button>
              ),
            };
          }}
        />
      </SectionCard>

      <div className="mb-6">
        <BottleUsageCard />
      </div>

      <SectionCard title="Recent movements" description="The ledger as the database recorded it.">
        <QueryState
          isLoading={movements.isLoading}
          error={movements.error}
          isEmpty={movementRows.length === 0}
          empty={
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <ArrowLeftRight className="h-4 w-4" /> No stock has moved yet.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {movementRows.map((m) => (
              <li
                key={String(m["id"])}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {String((m["stock_items"] as Row | null)?.["name"] ?? "Item")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {`${titleCase(String(m["movement_type"] ?? "movement"))} · ${String(m["reason"] ?? "")}`}
                    {m["source_requisition"]
                      ? ` · ${String((m["source_requisition"] as Row)["request_number"] ?? "Requisition")} · ${String(((m["source_requisition"] as Row)["departments"] as Row | null)?.["name"] ?? "Department not recorded")}`
                      : ""}
                  </p>
                </div>
                <span
                  className={Number(m["quantity"] ?? 0) < 0 ? "text-destructive" : "text-success"}
                >
                  {Number(m["quantity"] ?? 0) > 0 ? "+" : ""}
                  {Number(m["quantity"] ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}

// Every Supply Chain screen writes to stock, money or supplier records, so the
// page itself asks for the capability its route declares — never the shell.
function GuardedPage() {
  return (
    <OpsGuard path="/inventory/issues">
      <Page />
    </OpsGuard>
  );
}

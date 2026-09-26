import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStockItems, useStockLocations } from "@/lib/inventory-data";
import { titleCase, type Row } from "@/lib/inventory";
import {
  newNeedAttemptKey,
  useFulfilNeed,
  useLinkNeedItem,
  useRouteNeedToProcurement,
  useStockNeeds,
  type NeedRow,
} from "@/lib/stock-need-lifecycle";

export const Route = createFileRoute("/_shell/inventory/needs")({
  head: () => ({
    meta: [
      { title: "Stock needs and shortages — NEØ" },
      {
        name: "description",
        content:
          "Every reported or system-raised stock need in one queue: issue it from a store, issue part of it, or route the shortage to Procurement with its lineage kept.",
      },
      { property: "og:title", content: "Stock needs and shortages — NEØ" },
      {
        property: "og:description",
        content:
          "Fulfil, part-fulfil or route a stock need to Procurement — never a dead-end card.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function Page() {
  const needs = useStockNeeds("open");
  const items = useStockItems();
  const locations = useStockLocations();
  const link = useLinkNeedItem();
  const fulfil = useFulfilNeed();
  const route = useRouteNeedToProcurement();

  const [drafts, setDrafts] = useState<Record<string, { location: string; quantity: string }>>({});
  const [attemptKeys, setAttemptKeys] = useState<Record<string, string>>({});

  const needRows = (needs.data ?? []) as NeedRow[];
  const itemRows = (items.data ?? []) as Row[];
  const locationRows = (locations.data ?? []) as Row[];

  function draft(id: string) {
    return drafts[id] ?? { location: "", quantity: "" };
  }
  function setDraft(id: string, patch: Partial<{ location: string; quantity: string }>) {
    setDrafts((d) => ({ ...d, [id]: { ...draft(id), ...patch } }));
  }
  function keyFor(id: string) {
    const existing = attemptKeys[id];
    if (existing) return existing;
    const fresh = newNeedAttemptKey();
    setAttemptKeys((k) => ({ ...k, [id]: fresh }));
    return fresh;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supply Chain"
        title="Stock needs and shortages"
        description="One queue for every need, whether a department reported it or stock fell to its reorder point. Issue it from a store, issue part of it, or send the shortage to Procurement — the lineage from need to purchase request is kept."
      />

      <SectionCard
        title="Open needs"
        description="Each need stays here until it is issued in full or declined."
      >
        <QueryState
          isLoading={needs.isLoading}
          error={needs.error}
          isEmpty={needRows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              Nothing is outstanding — no department has reported a need.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {needRows.map((n) => {
              const id = String(n["id"]);
              const requested = Number(n["quantity"] ?? 0);
              const done = Number(n["fulfilled_quantity"] ?? 0);
              const outstanding = Math.max(requested - done, 0);
              const linkedItem = n["stock_item_id"] ? String(n["stock_item_id"]) : "";
              const pr = n["purchase_requests"] as Row | null;
              const d = draft(id);
              return (
                <li key={id} className="space-y-3 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{String(n["item"] ?? "Item not named")}</p>
                      <p className="text-xs text-muted-foreground">
                        {String((n["departments"] as Row | null)?.["name"] ?? "Department")} ·{" "}
                        {requested} {String(n["unit"] ?? "")} requested
                        {done > 0 ? ` · ${done} issued · ${outstanding} outstanding` : ""}
                      </p>
                      {pr ? (
                        <p className="text-xs text-muted-foreground">
                          With Procurement as {String(pr["request_number"] ?? "a request")} (
                          {titleCase(String(pr["status"] ?? ""))})
                        </p>
                      ) : null}
                    </div>
                    <Badge variant="outline">{titleCase(String(n["status"] ?? "reported"))}</Badge>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-4">
                    <div className="space-y-2 sm:col-span-2">
                      <Label>Stock item</Label>
                      <Select
                        value={linkedItem}
                        onValueChange={(v) => link.mutate({ needId: id, stockItemId: v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Link to a catalogue item" />
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
                    <div className="space-y-2">
                      <Label>Issue from</Label>
                      <Select
                        value={d.location}
                        onValueChange={(v) => setDraft(id, { location: v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Store" />
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
                      <Label htmlFor={`need-qty-${id}`}>Quantity</Label>
                      <Input
                        id={`need-qty-${id}`}
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder={String(outstanding)}
                        value={d.quantity}
                        onChange={(e) => setDraft(id, { quantity: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      disabled={
                        !linkedItem ||
                        !d.location ||
                        !(Number(d.quantity) > 0) ||
                        fulfil.isPending
                      }
                      onClick={() =>
                        fulfil.mutate(
                          {
                            needId: id,
                            locationId: d.location,
                            quantity: Number(d.quantity),
                            attemptKey: keyFor(id),
                          },
                          {
                            onSuccess: () => {
                              setDraft(id, { quantity: "" });
                              setAttemptKeys((k) => ({ ...k, [id]: newNeedAttemptKey() }));
                            },
                          },
                        )
                      }
                    >
                      Issue from store
                    </Button>
                    {/* A purchase can only be received into stock when the need
                        points at a catalogue item, so linking comes first. */}
                    {!linkedItem ? (
                      <span className="self-center text-xs text-muted-foreground">
                        Link a stock item to send this to Procurement
                      </span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={route.isPending || !linkedItem}
                      onClick={() => route.mutate({ needId: id })}
                    >
                      Route to Procurement
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/inventory/needs">
      <Page />
    </OpsGuard>
  );
}

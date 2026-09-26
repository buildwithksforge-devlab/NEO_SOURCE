/**
 * Minibar.
 *
 * Pick the guest's open folio, the minibar store the items came out of, then
 * the items themselves. Posting charges the folio and reduces that store in one
 * step — the two can never drift apart.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Minus, Plus, Wine } from "lucide-react";
import { PageHeader, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { formatMoney } from "@/lib/events";
import { useStockLocations } from "@/lib/inventory-data";
import {
  useChargeableFolios,
  useMinibarMenuItems,
  useMinibarPostings,
  usePostMinibar,
  type MinibarLine,
} from "@/lib/minibar";

export const Route = createFileRoute("/_shell/pms/minibar")({
  head: () => ({
    meta: [
      { title: "Minibar — NEØ Hospitality OS" },
      {
        name: "description",
        content:
          "Charge minibar consumption to a guest folio and take the same items out of the minibar store.",
      },
      { property: "og:title", content: "Minibar — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "Minibar consumption charged to the folio and deducted from the minibar store.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MinibarPage,
});

const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));

function MinibarPage() {
  const { can } = useAuth();
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;

  const folios = useChargeableFolios();
  const locations = useStockLocations();
  const menu = useMinibarMenuItems();
  const postings = useMinibarPostings();
  const post = usePostMinibar();

  const [folioId, setFolioId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");

  const canPost = can("front-office", "folios.create");

  const menuRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = menu.data ?? [];
    return q ? rows.filter((m) => str(m["name"]).toLowerCase().includes(q)) : rows;
  }, [menu.data, search]);

  const selectedFolio = (folios.data ?? []).find((f) => str(f["id"]) === folioId);
  const roomId = selectedFolio?.["reservations"]?.room_id ?? null;

  const chosen = useMemo(
    () =>
      Object.entries(lines)
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
          const item = (menu.data ?? []).find((m) => str(m["id"]) === id);
          return {
            menu_item_id: id,
            description: str(item?.["name"], "Minibar item"),
            quantity: qty,
            unit_price: Number(item?.["base_price"] ?? 0),
          } satisfies MinibarLine;
        }),
    [lines, menu.data],
  );

  const total = chosen.reduce((t, l) => t + l.quantity * l.unit_price, 0);
  const unpriced = chosen.filter((l) => !(l.unit_price > 0));
  const ready = Boolean(folioId && locationId && chosen.length > 0 && unpriced.length === 0);

  const bump = (id: string, by: number) =>
    setLines((prev) => {
      const next = Math.max((prev[id] ?? 0) + by, 0);
      const copy = { ...prev };
      if (next === 0) delete copy[id];
      else copy[id] = next;
      return copy;
    });

  const submit = async () => {
    if (!ready) return;
    await post.mutateAsync({
      folioId,
      locationId,
      roomId,
      notes: notes.trim() || null,
      lines: chosen,
    });
    setLines({});
    setNotes("");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Front office"
        title="Minibar"
        description="Charge what a guest took from the minibar and reduce the minibar store by the same items."
      />

      <SectionCard
        title="New minibar charge"
        description="Only items mapped to a stock item appear here — a charge always moves real stock."
        icon={Wine}
      >
        {!canPost ? (
          <p className="text-sm text-muted-foreground">
            You do not have permission to charge a guest folio.
          </p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Guest folio</Label>
                <Select value={folioId} onValueChange={setFolioId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose an open folio" />
                  </SelectTrigger>
                  <SelectContent>
                    {(folios.data ?? []).map((f) => {
                      const room = f["reservations"]?.rooms?.room_number;
                      return (
                        <SelectItem key={str(f["id"])} value={str(f["id"])}>
                          {`${str(f["folio_number"], "Folio")} · ${str(f["customers"]?.full_name, "Guest")}${room ? ` · Room ${room}` : ""}`}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {folios.data && folios.data.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No folio is open right now.</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label>Minibar store</Label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose the store the items came from" />
                  </SelectTrigger>
                  <SelectContent>
                    {(locations.data ?? []).map((l) => (
                      <SelectItem key={str(l["id"])} value={str(l["id"])}>
                        {str(l["name"], "Store")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Items</Label>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search minibar items"
              />
              <QueryState
                isLoading={menu.isLoading}
                error={menu.error}
                isEmpty={menuRows.length === 0}
                empty="No menu item is mapped to a stock item yet, so nothing can be charged from the minibar."
              >
                <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border">
                  {menuRows.map((m) => {
                    const id = str(m["id"]);
                    const price = Number(m["base_price"] ?? 0);
                    const qty = lines[id] ?? 0;
                    return (
                      <div key={id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <div>
                          <p className="font-medium">{str(m["name"], "Item")}</p>
                          <p className="text-xs text-muted-foreground">
                            {price > 0 ? formatMoney(symbol, price) : "No price set"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-8"
                            disabled={qty === 0}
                            onClick={() => bump(id, -1)}
                            aria-label={`Remove one ${str(m["name"], "item")}`}
                          >
                            <Minus className="size-4" />
                          </Button>
                          <span className="w-6 text-center tabular-nums">{qty}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => bump(id, 1)}
                            aria-label={`Add one ${str(m["name"], "item")}`}
                          >
                            <Plus className="size-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </QueryState>
            </div>

            <div className="space-y-1.5">
              <Label>Note (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the guest or the auditor should see"
              />
            </div>

            {unpriced.length > 0 ? (
              <p className="text-sm text-warning">
                {unpriced.map((l) => l.description).join(", ")} has no price set, so it cannot be
                charged. Set the price on the menu item first.
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {chosen.length === 0
                  ? "Nothing selected yet."
                  : `${chosen.length} line${chosen.length === 1 ? "" : "s"} · ${formatMoney(symbol, total)}`}
              </p>
              <Button disabled={!ready || post.isPending} onClick={() => void submit()}>
                {post.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Charge folio and reduce stock
              </Button>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Posted minibar charges"
        description="Each one charged a folio and moved the same items out of the store."
      >
        <QueryState
          isLoading={postings.isLoading}
          error={postings.error}
          isEmpty={(postings.data ?? []).length === 0}
          empty="No minibar consumption has been posted yet."
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Posted</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(postings.data ?? []).map((p) => {
                  const rows = (p["minibar_posting_lines"] ?? []) as Record<string, unknown>[];
                  return (
                    <TableRow key={str(p["id"])}>
                      <TableCell className="font-medium">{str(p["posting_number"], "—")}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {p["posted_at"] ? new Date(str(p["posted_at"])).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {rows
                          .map((l) => `${str(l["quantity"])} × ${str(l["description"])}`)
                          .join(", ") || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(symbol, Number(p["total_amount"] ?? 0))}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>
    </div>
  );
}

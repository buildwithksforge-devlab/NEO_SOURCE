import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { QueryState } from "@/components/kitchen/KitchenShared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { titleCase, type Row } from "@/lib/kitchen";
import { useKitchenStations, useRoutingCoverage, useSaveRoutingRule } from "@/lib/kitchen-data";
import {
  STATION_STATE_LABEL,
  summariseStations,
  useClearStationStore,
  usePropertyStores,
  useSetStationStore,
  useStationImpact,
  useStationStoreConsole,
  useStationStoreRules,
  type StationRoutingRule,
  type StationConsoleRow,
  type StationState,
} from "@/lib/station-store-routing";

const STATION_KIND: Record<string, string> = {
  beverage: "Bar / beverage",
  bar: "Bar",
  production: "Kitchen section",
  pastry: "Pastry",
  kitchen: "Kitchen section",
  service: "Service point",
};

const STATE_TONE: Record<StationState, "success" | "warning" | "destructive" | "default"> = {
  ready: "success",
  needs_setup: "warning",
  store_inactive: "destructive",
  cross_property: "destructive",
  no_production: "default",
};

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "";
}

/* ---------------------------------------------------------------- *
 * Assign / change a supply store
 * ---------------------------------------------------------------- */
function AssignDialog({
  station,
  open,
  onOpenChange,
}: {
  station: StationConsoleRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const stores = usePropertyStores(station?.branchId ?? null);
  const impact = useStationImpact(open ? (station?.stationId ?? null) : null);
  const set = useSetStationStore();
  const [choice, setChoice] = useState("");
  const [reason, setReason] = useState("");

  if (!station) return null;
  const changing = Boolean(station.locationId);
  const affected = (impact.data?.recipes.length ?? 0) + (impact.data?.menuItems.length ?? 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setChoice("");
          setReason("");
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {changing ? "Change supply store" : "Assign supply store"} — {station.stationName}
          </DialogTitle>
          <DialogDescription>
            {changing
              ? `Currently drawing from ${station.locationName}. Everything prepared here will deduct from the new store from now on; movements already posted keep their original store.`
              : "Choose the store this preparation point actually issues from. Only active stores on this property are listed."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="store-choice">Supply store</Label>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger id="store-choice" aria-label={`Store for ${station.stationName}`}>
                <SelectValue placeholder="Select a store" />
              </SelectTrigger>
              <SelectContent>
                {(stores.data ?? [])
                  .filter(
                    (s) =>
                      !station.branchId || s.branch_id === null || s.branch_id === station.branchId,
                  )
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      {s.location_type ? ` · ${titleCase(s.location_type)}` : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {changing && affected > 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
              <p className="font-medium">
                {affected} live record{affected === 1 ? "" : "s"} depend on this mapping
              </p>
              <p className="mt-1 text-muted-foreground">
                {impact.data?.recipes.length ?? 0} active recipe
                {(impact.data?.recipes.length ?? 0) === 1 ? "" : "s"} ·{" "}
                {impact.data?.menuItems.length ?? 0} menu item
                {(impact.data?.menuItems.length ?? 0) === 1 ? "" : "s"}:{" "}
                {[...(impact.data?.recipes ?? []), ...(impact.data?.menuItems ?? [])]
                  .slice(0, 8)
                  .map((r) => r.name)
                  .join(", ")}
                {affected > 8 ? "…" : ""}
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="assign-reason">Reason {changing ? "(recorded in the audit trail)" : "(optional)"}</Label>
            <Textarea
              id="assign-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this store?"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!choice || set.isPending}
            onClick={async () => {
              await set.mutateAsync({
                stationId: station.stationId,
                locationId: choice,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              });
              onOpenChange(false);
              setChoice("");
              setReason("");
            }}
          >
            {set.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Save mapping
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- *
 * Remove a mapping, with what it would affect
 * ---------------------------------------------------------------- */
function RemoveDialog({
  station,
  open,
  onOpenChange,
}: {
  station: StationConsoleRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const impact = useStationImpact(open ? (station?.stationId ?? null) : null);
  const clear = useClearStationStore();
  const [reason, setReason] = useState("");
  if (!station) return null;
  const recipes = impact.data?.recipes ?? [];
  const items = impact.data?.menuItems ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove supply store — {station.stationName}</DialogTitle>
          <DialogDescription>
            The station stops drawing from {station.locationName ?? "its store"}. Stock movements
            already posted keep their original store and are never rewritten.
          </DialogDescription>
        </DialogHeader>

        {recipes.length + items.length > 0 ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
            <p className="font-medium">
              {recipes.length} active recipe{recipes.length === 1 ? "" : "s"} and {items.length} menu
              item{items.length === 1 ? "" : "s"} depend on this mapping
            </p>
            <p className="mt-1 text-muted-foreground">
              {[...recipes, ...items]
                .slice(0, 12)
                .map((r) => r.name)
                .join(", ")}
              {recipes.length + items.length > 12 ? "…" : ""}
            </p>
            <p className="mt-2 text-muted-foreground">
              Removal is refused if it would leave these unable to post stock. Reroute or deactivate
              them first.
            </p>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="remove-reason">Reason</Label>
          <Textarea
            id="remove-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this mapping being removed?"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={clear.isPending || !reason.trim()}
            onClick={async () => {
              try {
                await clear.mutateAsync({ stationId: station.stationId, reason: reason.trim() });
                onOpenChange(false);
                setReason("");
              } catch {
                /* the error is shown by the mutation */
              }
            }}
          >
            {clear.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Remove mapping
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- *
 * The mapping workspace
 * ---------------------------------------------------------------- */
function StationStoreWorkspace({ canEdit }: { canEdit: boolean }) {
  const console_ = useStationStoreConsole();
  const rows = useMemo(() => console_.data ?? [], [console_.data]);
  const summary = summariseStations(rows);
  const [assign, setAssign] = useState<StationConsoleRow | null>(null);
  const [remove, setRemove] = useState<StationConsoleRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const impact = useStationImpact(expanded);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Production stations", value: summary.total },
          { label: "Ready", value: summary.ready },
          { label: "Need setup", value: summary.needsSetup },
          { label: "Active recipes", value: summary.recipes },
          { label: "Routed menu items", value: summary.routedItems },
          { label: "Cannot post stock", value: summary.blocked },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className="text-2xl font-semibold tabular-nums">{c.value}</p>
          </div>
        ))}
      </div>

      <SectionCard
        title="Station supply stores"
        description="Every preparation point on this property and the store it issues from. This mapping is what the till, kitchen display, bar queue and pastry production all deduct against."
      >
        {summary.needsSetup > 0 ? (
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-on-tint-warning" />
            <p className="text-muted-foreground">
              {summary.needsSetup} station{summary.needsSetup === 1 ? "" : "s"} cannot deduct stock
              yet. Items sent there are blocked rather than taken from another outlet’s store.
            </p>
          </div>
        ) : null}

        <QueryState
          isLoading={console_.isLoading}
          error={console_.error}
          isEmpty={rows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No active preparation points on this property yet.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.stationId} className="py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {r.stationName}
                      {r.stationCode ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {r.stationCode}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {STATION_KIND[r.stationType] ?? titleCase(r.stationType)}
                      {r.departmentName ? ` · ${r.departmentName}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.locationName
                        ? `Draws from ${r.locationName}${r.mappedExplicitly ? "" : " (inherited from the department)"}`
                        : "No store — items sent here are blocked"}
                      {` · ${r.recipesActive} active recipe${r.recipesActive === 1 ? "" : "s"}, ${
                        r.directItems + r.routedItems
                      } menu item${r.directItems + r.routedItems === 1 ? "" : "s"}`}
                    </p>
                    {r.state === "ready" && r.recipesActive + r.directItems + r.routedItems === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Store is usable — no recipes or menu items are routed here yet.
                      </p>
                    ) : null}
                    {r.changedAt ? (
                      <p className="text-xs text-muted-foreground">
                        Last changed {when(r.changedAt)} ·{" "}
                        {r.changedByName ?? "Actor not captured"}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={STATE_TONE[r.state]}>
                      {STATION_STATE_LABEL[r.state]}
                    </StatusPill>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded(expanded === r.stationId ? null : r.stationId)}
                    >
                      {expanded === r.stationId ? "Hide affected" : "View affected"}
                    </Button>
                    {canEdit ? (
                      <>
                        <Button size="sm" onClick={() => setAssign(r)}>
                          {r.mappedExplicitly ? "Change store" : "Assign store"}
                        </Button>
                        {r.mappedExplicitly ? (
                          <Button size="sm" variant="outline" onClick={() => setRemove(r)}>
                            Remove
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>

                {expanded === r.stationId ? (
                  <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                    {impact.isLoading ? (
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> Loading affected records…
                      </span>
                    ) : (impact.data?.recipes.length ?? 0) + (impact.data?.menuItems.length ?? 0) ===
                      0 ? (
                      <p className="text-muted-foreground">
                        Nothing is prepared at this station yet.
                      </p>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="font-medium">
                            Recipes ({impact.data?.recipes.length ?? 0})
                          </p>
                          <p className="text-muted-foreground">
                            {(impact.data?.recipes ?? []).map((x) => x.name).join(", ") || "None"}
                          </p>
                        </div>
                        <div>
                          <p className="font-medium">
                            Menu items ({impact.data?.menuItems.length ?? 0})
                          </p>
                          <p className="text-muted-foreground">
                            {(impact.data?.menuItems ?? []).map((x) => x.name).join(", ") || "None"}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </QueryState>

        {!canEdit ? (
          <p className="mt-4 text-xs text-muted-foreground">
            You can see readiness here. Changing a supply store needs kitchen settings edit rights.
          </p>
        ) : null}
      </SectionCard>

      <AssignDialog
        station={assign}
        open={assign !== null}
        onOpenChange={(v) => (v ? undefined : setAssign(null))}
      />
      <RemoveDialog
        station={remove}
        open={remove !== null}
        onOpenChange={(v) => (v ? undefined : setRemove(null))}
      />
    </>
  );
}

/**
 * Unrouted menu categories are the reason live tickets print "No Station".
 * The database never guesses a station when a workspace runs more than one
 * production section, so the gap has to be closed here — by the kitchen,
 * deliberately — rather than by inventing a default nobody agreed to.
 */
function RoutingCoverage({ canEdit }: { canEdit: boolean }) {
  const coverage = useRoutingCoverage();
  const stations = useKitchenStations();
  const save = useSaveRoutingRule();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const stationRows = (stations.data ?? []) as Row[];

  if (coverage.isLoading) return null;
  if (coverage.unrouted.length === 0 && coverage.orphanItems === 0) {
    return (
      <SectionCard
        title="Routing coverage"
        description="Every menu item resolves to a preparation station."
      >
        <p className="py-4 text-sm text-muted-foreground">
          All {coverage.totalItems} menu items reach a station. No ticket will show “No Station”.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Unrouted menu categories"
      description="Items in these categories cannot reach a chef until a station is chosen."
    >
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-on-tint-warning" />
        <p className="text-muted-foreground">
          Tickets for these items display “No Station” on the kitchen display. Assign the station
          that actually prepares them — nothing is assigned automatically.
        </p>
      </div>
      <ul className="divide-y divide-border">
        {coverage.unrouted.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div>
              <p className="font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground">
                {c.items} unrouted item{c.items === 1 ? "" : "s"}
              </p>
            </div>
            {canEdit ? (
              <div className="flex items-center gap-2">
                <Select
                  value={choice[c.id] ?? ""}
                  onValueChange={(v) => setChoice((p) => ({ ...p, [c.id]: v }))}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="Select station" />
                  </SelectTrigger>
                  <SelectContent>
                    {stationRows.map((s) => (
                      <SelectItem key={String(s["id"])} value={String(s["id"])}>
                        {String(s["name"] ?? "Station")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!choice[c.id] || save.isPending}
                  onClick={() =>
                    save.mutate({
                      category_id: c.id,
                      station_id: choice[c.id] as string,
                      priority: 100,
                      active: true,
                    })
                  }
                >
                  Route
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {coverage.orphanItems > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {coverage.orphanItems} item{coverage.orphanItems === 1 ? " has" : "s have"} no category at
          all — set a station on the item in Menu Management.
        </p>
      ) : null}
    </SectionCard>
  );
}

function RoutingRules() {
  const query = useStationStoreRules();
  const rows = query.data ?? [];
  return (
    <SectionCard
      title="Routing rules"
      description="Category and item rules captured by your kitchen team. Nothing here is simulated."
    >
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={rows.length === 0}
        empty={
          <p className="py-6 text-sm text-muted-foreground">
            No category rules yet — items reach their station directly.
          </p>
        }
      >
        <ul className="divide-y divide-border">
          {rows.map((r: StationRoutingRule) => (
            <li key={r.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium">{r.stationName}</p>
                <p className="text-xs text-muted-foreground">
                  {r.subject} · priority {r.priority}
                </p>
              </div>
              <StatusPill tone={r.active ? "success" : "default"}>
                {r.active ? "Active" : "Inactive"}
              </StatusPill>
            </li>
          ))}
        </ul>
      </QueryState>
    </SectionCard>
  );
}

export const Route = createFileRoute("/_shell/kitchen/settings")({
  head: () => ({
    meta: [
      { title: "Kitchen settings & station routing — NEØ" },
      {
        name: "description",
        content:
          "Map every preparation point to the store it issues from, and see which recipes and menu items can post stock.",
      },
      { property: "og:title", content: "Kitchen settings & station routing — NEØ" },
      {
        property: "og:description",
        content: "Station supply stores, readiness and routing coverage for the selected property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const { can, loading } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  const canView =
    can("kitchen", "settings", "view") ||
    can("kitchen", "settings", "edit") ||
    can("kitchen", "settings.manage");
  const canEdit = can("kitchen", "settings", "edit") || can("kitchen", "settings.manage");

  if (!canView) {
    return (
      <AccessDeniedPanel
        subject="kitchen settings"
        detail="Required capability: kitchen.settings.view"
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Kitchen settings & station routing"
        description="Where each ordered item is prepared, and which store that preparation point deducts from."
      />
      <StationStoreWorkspace canEdit={canEdit} />
      <RoutingCoverage canEdit={canEdit} />
      <RoutingRules />
    </div>
  );
}

/**
 * Station stock — Work.
 *
 * Each station sees the ingredients held in its own consumption store, the
 * balance after POS service has drawn on it, the reorder alerts derived from
 * recorded reorder points, and the POS-linked movements that produced the
 * current balance. Read-only: every write stays with the canonical stores and
 * POS routines.
 */
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/common/StateSystem";
import { formatQuantity, healthLabel, healthTone, titleCase } from "@/lib/inventory";
import {
  reorderAlerts,
  unconfiguredItems,
  useMyStations,
  useStationConsumption,
  useStationStockLevels,
  useStationStores,
} from "@/lib/station-stock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_shell/station-stock")({
  head: () => ({
    meta: [
      { title: "Station stock — Work — NEØ" },
      {
        name: "description",
        content:
          "Ingredients, live balances and reorder alerts for the store your station consumes from, with the POS movements behind them.",
      },
      { property: "og:title", content: "Station stock — Work — NEØ" },
      {
        property: "og:description",
        content: "Track your station's ingredients, stock levels and reorder alerts against POS service.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StationStockPage,
});

function StationStockPage() {
  const stations = useMyStations();
  const [stationId, setStationId] = useState<string | null>(null);
  const list = stations.data ?? [];

  useEffect(() => {
    if (!stationId && list.length > 0) setStationId(list[0]!.stationId);
  }, [list, stationId]);

  const stores = useStationStores(stationId);
  const locationIds = useMemo(() => (stores.data ?? []).map((s) => s.locationId), [stores.data]);
  const levels = useStationStockLevels(locationIds);
  const movements = useStationConsumption(locationIds);

  const rows = levels.data ?? [];
  const alerts = reorderAlerts(rows);
  const unconfigured = unconfiguredItems(rows);

  return (
    <div>
      <PageHeader
        eyebrow="Work"
        title="Station stock"
        description="What your station actually holds, what service has already consumed, and what is at or below its reorder point."
      />

      <QueryState
        isLoading={stations.isLoading}
        error={stations.error}
        isEmpty={list.length === 0}
        empty={
          <EmptyState
            title="No station assigned to you"
            description="Station stock follows your station assignment. Ask your supervisor to assign you to a station and it appears here."
          />
        }
      >
        <div className="mb-6 flex flex-wrap gap-2">
          {list.map((s) => (
            <button
              key={s.stationId}
              type="button"
              onClick={() => setStationId(s.stationId)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm transition-colors",
                s.stationId === stationId
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {s.stationName}
            </button>
          ))}
        </div>

        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <SectionCard title="Ingredients tracked">
            <p className="text-3xl font-semibold">{rows.length}</p>
          </SectionCard>
          <SectionCard title="At or below reorder point">
            <p className="text-3xl font-semibold">{alerts.length}</p>
          </SectionCard>
          <SectionCard title="No reorder point recorded">
            <p className="text-3xl font-semibold">{unconfigured.length}</p>
          </SectionCard>
        </div>

        <SectionCard
          title="Reorder alerts"
          description="Only items with a recorded reorder point are judged — nothing is assumed for the rest."
          className="mb-6"
        >
          <QueryState
            isLoading={levels.isLoading || stores.isLoading}
            error={levels.error ?? stores.error}
            isEmpty={locationIds.length === 0 || alerts.length === 0}
            empty={
              locationIds.length === 0 ? (
                <EmptyState
                  title="This station has no consumption store"
                  description="Stock cannot be tracked until the station is mapped to the store it draws from. A stores manager sets this in Kitchen stores."
                />
              ) : (
                <EmptyState
                  title="Nothing below its reorder point"
                  description="Every ingredient with a recorded reorder point is currently above it."
                />
              )
            }
          >
            <ul className="divide-y divide-border">
              {alerts.map((r) => (
                <li key={r.itemId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Reorder point {formatQuantity(r.reorderPoint, r.unit)}
                      {r.parLevel !== null ? ` · Par ${formatQuantity(r.parLevel, r.unit)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm">{formatQuantity(r.onHand, r.unit)} on hand</span>
                    <StatusPill tone={healthTone(r.health)}>{healthLabel(r.health)}</StatusPill>
                  </div>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Ingredients in my store"
          description="Balances held in the store this station consumes from."
          className="mb-6"
        >
          <QueryState
            isLoading={levels.isLoading || stores.isLoading}
            error={levels.error ?? stores.error}
            isEmpty={rows.length === 0}
            empty={
              <EmptyState
                title="No stock recorded yet"
                description="Once opening stock is entered or a delivery is received into this store, the balances appear here."
              />
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Ingredient</th>
                    <th className="py-2 pr-4 font-medium">On hand</th>
                    <th className="py-2 pr-4 font-medium">Reserved</th>
                    <th className="py-2 pr-4 font-medium">Reorder point</th>
                    <th className="py-2 font-medium">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.itemId}>
                      <td className="py-2 pr-4">{r.name}</td>
                      <td className="py-2 pr-4">{formatQuantity(r.onHand, r.unit)}</td>
                      <td className="py-2 pr-4">{formatQuantity(r.reserved, r.unit)}</td>
                      <td className="py-2 pr-4">
                        {r.reorderPoint === null ? (
                          <span className="text-muted-foreground">Not configured</span>
                        ) : (
                          formatQuantity(r.reorderPoint, r.unit)
                        )}
                      </td>
                      <td className="py-2">
                        <StatusPill tone={healthTone(r.health)}>{healthLabel(r.health)}</StatusPill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Recent movements behind these balances"
          description="Issues, receipts and the consumption POS tickets have already posted against this store."
        >
          <QueryState
            isLoading={movements.isLoading}
            error={movements.error}
            isEmpty={(movements.data ?? []).length === 0}
            empty={
              <EmptyState
                title="No movements yet"
                description="Stock moves when a ticket is served against a costed recipe, or when stores issue or receive into this store."
              />
            }
          >
            <ul className="divide-y divide-border">
              {(movements.data ?? []).map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <p className="font-medium">{m.itemName}</p>
                    <p className="text-sm text-muted-foreground">
                      {titleCase(m.movementType)}
                      {m.referenceType ? ` · ${titleCase(m.referenceType)}` : ""} ·{" "}
                      {new Date(m.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="text-sm">{formatQuantity(m.quantity, m.unit)}</span>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>

        <p className="mt-6 text-sm text-muted-foreground">
          Requesting more stock stays with the canonical flow —{" "}
          <Link to="/kitchen/needs" className="underline">
            report a shortage to Stores
          </Link>
          .
        </p>
      </QueryState>
    </div>
  );
}

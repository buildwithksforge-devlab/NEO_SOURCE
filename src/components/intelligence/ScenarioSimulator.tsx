/**
 * Scenario simulator — deterministic arithmetic only.
 *
 * NEØ moves one assumption at a time against the recorded sellable-room count
 * and the recorded average room value, and shows the result of that arithmetic.
 * It is not a forecast: if either input is missing from the records, the output
 * is withheld and the missing input is named.
 */
import { useState } from "react";
import { Slider } from "@/components/ui/slider";
import { simulateOccupancy } from "@/lib/intelligence-engine";

export function ScenarioSimulator({
  sellable,
  averageValue,
  currency,
  moneyVisible,
  baselineOccupancy,
}: {
  sellable: number | null;
  averageValue: number | null;
  currency: string;
  moneyVisible: boolean;
  baselineOccupancy: number | null;
}) {
  const [occupancy, setOccupancy] = useState<number>(Math.round(baselineOccupancy ?? 70));
  const result = simulateOccupancy(sellable, occupancy, moneyVisible ? averageValue : null);
  const fmt = (v: number) => new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(v);

  return (
    <section data-testid="scenario-simulator" className="neo-decision space-y-3 rounded-2xl border border-outline-subtle p-4">
      <header>
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          NEØ scenario
        </p>
        <h4 className="mt-1 text-sm font-semibold">If occupancy were {occupancy}%</h4>
      </header>

      <Slider
        value={[occupancy]}
        min={0}
        max={100}
        step={1}
        onValueChange={(v) => setOccupancy(v[0] ?? occupancy)}
        aria-label="Assumed occupancy percentage"
      />

      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0 rounded-xl bg-card/60 px-3 py-2">
          <dt className="truncate text-xs text-muted-foreground">Sellable rooms (recorded)</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{sellable === null ? "—" : fmt(sellable)}</dd>
        </div>
        <div className="min-w-0 rounded-xl bg-card/60 px-3 py-2">
          <dt className="truncate text-xs text-muted-foreground">Rooms sold at this assumption</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{result.rooms === null ? "—" : fmt(result.rooms)}</dd>
        </div>
        <div className="min-w-0 rounded-xl bg-card/60 px-3 py-2">
          <dt className="truncate text-xs text-muted-foreground">Room value at this assumption</dt>
          <dd className="mt-0.5 truncate text-lg font-semibold tabular-nums">
            {result.value === null ? "—" : `${currency} ${fmt(result.value)}`}
          </dd>
        </div>
      </dl>

      <p className="text-xs text-muted-foreground">
        {sellable === null
          ? "NEØ cannot verify this yet — no sellable-room count is recorded for this scope."
          : !moneyVisible
            ? "Room count only: monetary values are not visible to your role."
            : averageValue === null
              ? "Room count only: no recorded average room value exists for this period, so NEØ withholds the value."
              : "Arithmetic on recorded sellable rooms and the recorded average room value. No demand, pricing or seasonality model is applied."}
      </p>
    </section>
  );
}

/**
 * Renders a `Visualization` description produced by the deterministic engine.
 * The renderer never derives a value — it only draws what it is handed, and it
 * draws each kind in the language that suits the decision: lines for trends,
 * bars for comparisons, a waterfall to explain a movement, a heatmap for
 * demand patterns, a table when the detail matters more than the shape.
 */
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_PROPS,
  BAR_PROPS,
  ChartGradients,
  GRID_PROPS,
  LINE_PROPS,
  TOOLTIP_PROPS,
  chartFill,
  chartSeriesColor,
} from "@/components/charts/ChartKit";
import { TableScroll } from "@/components/common/DataDisplay";
import type { Visualization } from "@/lib/intelligence-types";

const fmt = (v: number) => new Intl.NumberFormat("en-KE", { maximumFractionDigits: 1 }).format(v);

function Frame({ title, note, children }: { title: string; note?: string | undefined; children: React.ReactNode }) {
  return (
    <figure className="neo-viz min-w-0 rounded-2xl border border-outline-subtle bg-card/70 p-3">
      <figcaption className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{title}</figcaption>
      {children}
      {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
    </figure>
  );
}

/** Signed contributions between a start and an end value. */
function Waterfall({ viz }: { viz: Extract<Visualization, { kind: "waterfall" }> }) {
  const max = Math.max(1, ...viz.steps.map((s) => Math.abs(s.value)));
  return (
    <Frame title={viz.title} note={viz.note}>
      <ul className="space-y-1.5">
        {viz.steps.map((s, i) => {
          const total = s.kind === "start" || s.kind === "total";
          const width = `${Math.max(4, (Math.abs(s.value) / max) * 100)}%`;
          return (
            <li key={`${s.label}-${i}`} className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_auto] items-center gap-2">
              <span className="truncate text-xs text-muted-foreground">{s.label}</span>
              <span className="flex h-5 items-center">
                <span
                  className="h-2.5 rounded-full transition-[width] duration-500 ease-out"
                  style={{
                    width,
                    background: total
                      ? "var(--color-muted-foreground)"
                      : s.value >= 0
                        ? chartSeriesColor(0)
                        : "var(--color-destructive)",
                  }}
                />
              </span>
              <span className="text-xs font-medium tabular-nums">
                {s.value > 0 && !total ? "+" : ""}
                {fmt(s.value)}
              </span>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

/** Two-dimensional pattern. Missing cells stay blank — never zero-filled. */
function Heatmap({ viz }: { viz: Extract<Visualization, { kind: "heatmap" }> }) {
  const values = viz.rows.flat().filter((v): v is number => v !== null);
  const max = values.length ? Math.max(...values) : 0;
  return (
    <Frame title={viz.title} note={viz.note}>
      <TableScroll>
        <table className="w-full min-w-[20rem] border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="w-16" />
              {viz.xLabels.map((x) => (
                <th key={x} className="pb-1 text-center font-medium text-muted-foreground">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {viz.yLabels.map((y, yi) => (
              <tr key={y}>
                <th scope="row" className="pr-2 text-right font-medium text-muted-foreground">
                  {y}
                </th>
                {viz.xLabels.map((x, xi) => {
                  const v = viz.rows[yi]?.[xi] ?? null;
                  const intensity = v === null || max === 0 ? 0 : Math.min(1, v / max);
                  return (
                    <td
                      key={x}
                      title={`${y} · ${x}: ${v === null ? "not recorded" : fmt(v)}`}
                      className="h-7 rounded-md text-center tabular-nums"
                      style={
                        v === null
                          ? { border: "1px dashed var(--color-border)" }
                          : {
                              background: `color-mix(in oklab, ${chartSeriesColor(0)} ${Math.round(12 + intensity * 78)}%, transparent)`,
                            }
                      }
                    >
                      {v === null ? "" : fmt(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Frame>
  );
}

export function VizRenderer({ viz }: { viz: Visualization | null }) {
  if (!viz) return null;

  if (viz.kind === "metric") {
    return (
      <div className="rounded-xl border border-outline-subtle bg-card/70 px-4 py-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{viz.title}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{viz.value}</p>
        {viz.hint ? <p className="mt-0.5 text-xs text-muted-foreground">{viz.hint}</p> : null}
      </div>
    );
  }

  if (viz.kind === "waterfall") return <Waterfall viz={viz} />;
  if (viz.kind === "heatmap") return <Heatmap viz={viz} />;

  if (viz.kind === "table") {
    if (viz.rows.length === 0) return null;
    return (
      <Frame title={viz.title}>
        <TableScroll>
          <table className="w-full min-w-[22rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                {viz.columns.map((c) => (
                  <th key={c.key} className="py-2 pr-3">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {viz.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/60">
                  {viz.columns.map((c) => (
                    <td key={c.key} className="py-2 pr-3 tabular-nums">
                      {row[c.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Frame>
    );
  }

  const unit = viz.unit === "percent" ? "%" : undefined;
  return (
    <Frame title={viz.title}>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {viz.kind === "bar" ? (
            <BarChart data={viz.data} margin={{ left: -18, right: 8, top: 6 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey={viz.xKey} {...AXIS_PROPS} minTickGap={12} />
              <YAxis {...AXIS_PROPS} width={40} {...(unit ? { unit } : {})} />
              <Tooltip {...TOOLTIP_PROPS} />
              {viz.series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={chartSeriesColor(i)} {...BAR_PROPS} />
              ))}
            </BarChart>
          ) : viz.kind === "line" ? (
            <LineChart data={viz.data} margin={{ left: -18, right: 8, top: 6 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey={viz.xKey} {...AXIS_PROPS} minTickGap={12} />
              <YAxis {...AXIS_PROPS} width={40} {...(unit ? { unit } : {})} />
              <Tooltip {...TOOLTIP_PROPS} />
              {viz.series.map((s, i) => (
                <Line key={s.key} {...LINE_PROPS} dataKey={s.key} name={s.label} stroke={chartSeriesColor(i)} />
              ))}
            </LineChart>
          ) : (
            <AreaChart data={viz.data} margin={{ left: -18, right: 8, top: 6 }}>
              <ChartGradients idPrefix="neoviz" />
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey={viz.xKey} {...AXIS_PROPS} minTickGap={12} />
              <YAxis {...AXIS_PROPS} width={40} {...(unit ? { unit } : {})} />
              <Tooltip {...TOOLTIP_PROPS} />
              {viz.series.map((s, i) => (
                <Area
                  key={s.key}
                  {...LINE_PROPS}
                  dataKey={s.key}
                  name={s.label}
                  stroke={chartSeriesColor(i)}
                  fill={chartFill(i, "neoviz")}
                />
              ))}
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </Frame>
  );
}

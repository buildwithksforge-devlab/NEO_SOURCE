/**
 * The shared NEØ chart system.
 *
 * Every chart in the product is framed the same way: a title, a subtitle that
 * states the unit and period, an optional legend, a designed empty state and a
 * source line. Axes, gridlines and tooltips come from one place so a chart in
 * Finance reads identically to a chart in PMS, in either theme, and none of
 * them fabricate a value that is not in the data.
 */
import type { ReactNode } from "react";
import { BarChart3 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Brand-led series palette — never a random rainbow. */
export const CHART_SERIES = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
] as const;

export const chartSeriesColor = (index: number) =>
  CHART_SERIES[index % CHART_SERIES.length] as string;

/**
 * Shared gradient defs for area/bar fills. One `<ChartGradients />` inside the
 * chart gives every series a soft, clearly visible wash keyed to its series
 * colour — referenced with `chartFill(index)`.
 */
export function ChartGradients({ idPrefix = "neo" }: { idPrefix?: string }) {
  return (
    <defs>
      {CHART_SERIES.map((color, i) => (
        <linearGradient key={i} id={`${idPrefix}-fill-${i}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.55} />
          <stop offset="55%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0.04} />
        </linearGradient>
      ))}
    </defs>
  );
}

export const chartFill = (index: number, idPrefix = "neo") =>
  `url(#${idPrefix}-fill-${index % CHART_SERIES.length})`;

/** Line/area stroke defaults: substantial enough to read on a phone. */
export const LINE_PROPS = {
  type: "monotone",
  strokeWidth: 2.5,
  dot: false,
  activeDot: { r: 4.5, strokeWidth: 2, stroke: "var(--color-card)" },
} as const;

/** Bars: rounded caps, deliberate spacing, never full-bleed slabs. */
export const BAR_PROPS: { radius: [number, number, number, number]; maxBarSize: number } = {
  radius: [7, 7, 2, 2],
  maxBarSize: 42,
};

/** Axis defaults: quiet ticks, no heavy axis rules. */
export const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  stroke: "var(--color-muted-foreground)",
  tick: { fontSize: 11, fill: "var(--color-muted-foreground)" },
  minTickGap: 12,
} as const;

/** Gridlines are present but subordinate to the data. */
export const GRID_PROPS = {
  strokeDasharray: "2 6",
  stroke: "color-mix(in oklab, var(--color-foreground) 14%, transparent)",
  vertical: false,
} as const;

/** A tooltip that reads as a small elevated card rather than browser chrome. */
export const TOOLTIP_PROPS = {
  cursor: {
    stroke: "color-mix(in oklab, var(--color-primary) 45%, transparent)",
    strokeWidth: 1.5,
  },
  contentStyle: {
    background: "var(--color-popover)",
    border: "1px solid var(--color-border)",
    borderRadius: "0.85rem",
    boxShadow: "0 18px 44px -20px oklch(0.16 0.032 264 / 0.55)",
    fontSize: "0.75rem",
    padding: "0.6rem 0.8rem",
    color: "var(--color-popover-foreground)",
  },
  labelStyle: {
    color: "var(--color-muted-foreground)",
    fontSize: "0.68rem",
    marginBottom: "0.25rem",
  },
  itemStyle: { color: "var(--color-popover-foreground)" },
} as const;

export type ChartSeries = { label: string; color: string; kind?: "line" | "area" | "bar" | "dot" };

export function ChartLegend({ series }: { series: ChartSeries[] }) {
  if (series.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {series.map((s) => (
        <li
          key={s.label}
          className="inline-flex items-center gap-1.5 rounded-full bg-card/70 px-2 py-0.5 text-xs font-medium text-foreground/80"
        >
          <span
            aria-hidden
            className={cn(
              "inline-block size-2.5 shrink-0",
              s.kind === "line" ? "h-[3px] w-5 rounded-full" : "rounded-[4px]",
            )}
            style={{ background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Frame for any visual: consistent hierarchy (title → unit/period → legend →
 * plot → source) with a responsive plot height and a designed empty state.
 */
export function ChartCard({
  title,
  subtitle,
  series = [],
  source,
  actions,
  children,
  empty,
  emptyTitle = "No data for this period",
  emptyDescription = "Nothing has been recorded for the selected filters. No values are estimated to fill the gap.",
  size = "default",
  className,
  tone = "primary",
}: {
  title: string;
  /** Unit and period, e.g. "Occupancy % · last 30 days". */
  subtitle?: string;
  series?: ChartSeries[];
  source?: string;
  actions?: ReactNode;
  children: ReactNode;
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  size?: "default" | "compact";
  className?: string;
  tone?: "primary" | "quiet";
}) {
  return (
    <Card
      className={cn(
        tone === "quiet" ? "surface-quiet shadow-none" : "surface-panel neo-chart-card",
        "gap-0 overflow-hidden py-0",
        className,
      )}
    >
      <CardContent className="neo-card-pad">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden
              className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"
            >
              <BarChart3 className="size-4" />
            </span>
            <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">{title}</h3>
            {subtitle ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
            ) : null}
            </div>
          </div>
          {actions ? (
            <div data-action-cluster className="flex shrink-0 items-center gap-2">
              {actions}
            </div>
          ) : null}
        </div>

        {series.length ? (
          <div className="mt-2">
            <ChartLegend series={series} />
          </div>
        ) : null}

        {empty ? (
          <div className="mt-3 flex flex-col items-center justify-center rounded-xl border border-dashed border-outline-subtle px-6 py-10 text-center">
            <span className="mb-3 rounded-xl bg-muted p-3 text-muted-foreground">
              <BarChart3 className="size-5" />
            </span>
            <p className="text-sm font-semibold text-foreground">{emptyTitle}</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">{emptyDescription}</p>
          </div>
        ) : (
          <div
            role="img"
            aria-label={[title, subtitle].filter(Boolean).join(". ")}
            className={cn(
              "neo-chart-plot mt-3",
              size === "compact" ? "neo-chart-h-sm" : "neo-chart-h",
            )}
          >
            {children}
          </div>
        )}

        {source ? (
          <p className="mt-3 border-t border-outline-subtle pt-2 text-[0.68rem] text-muted-foreground">
            Source: {source}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BarChart3,
  Clock,
  Database,
  Info,
  PlugZap,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { StatusPill } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ErrorState as SharedErrorState,
  LoadingState,
  NotConfiguredState,
} from "@/components/common/StateSystem";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ChartCard, type ChartSeries } from "@/components/charts/ChartKit";
import {
  deltaLabel,
  formatMetric,
  freshnessLabels,
  type FreshnessClass,
  type MetricDefinition,
} from "@/lib/analytics";

/* ------------------------------------------------------------------ *
 * Freshness + provenance
 * ------------------------------------------------------------------ */

export function FreshnessBadge({
  freshness,
  generatedAt,
  failed,
}: {
  freshness: FreshnessClass;
  generatedAt?: string | null;
  failed?: boolean;
}) {
  const cls: FreshnessClass = failed ? "refresh_failed" : freshness;
  const tone = failed ? "destructive" : cls === "realtime" || cls === "near_realtime" ? "success" : "info";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="size-3" />
      <StatusPill tone={tone as any}>{freshnessLabels[cls]}</StatusPill>
      {generatedAt ? <span>· {new Date(generatedAt).toLocaleString()}</span> : null}
    </span>
  );
}

/** Definition drawer — every number on screen can explain itself. */
export function MetricDefinitionDialog({
  metric,
  trigger,
}: {
  metric: MetricDefinition;
  trigger?: ReactNode;
}) {
  const rows: [string, string][] = [
    ["Metric code", metric.code],
    ["Business meaning", metric.businessMeaning],
    ["Formula", metric.formula],
    ["Numerator", metric.numerator],
    ["Denominator", metric.denominator],
    ["Included records", metric.includedRecords],
    ["Excluded records", metric.excludedRecords],
    ["Source tables", metric.sources.join(", ")],
    ["Date field", metric.dateField],
    ["Currency treatment", metric.currencyTreatment],
    ["Scope", metric.scope],
    ["Refresh frequency", freshnessLabels[metric.refresh]],
    ["Owner", metric.owner],
    ["Version", `v${metric.version} · effective ${metric.effectiveDate}`],
    ["Status", metric.status.replace("_", " ")],
  ];
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            aria-label={`Definition of ${metric.name}`}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Info className="size-3.5" />
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{metric.name}</DialogTitle>
          <DialogDescription>{metric.description}</DialogDescription>
        </DialogHeader>
        <dl className="space-y-3 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[9rem_1fr] gap-3">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/** Governed metric card: value, definition, source, freshness, comparison. */
export function MetricCard({
  metric,
  value,
  previous,
  symbol,
  generatedAt,
  onDrillDown,
  warning,
}: {
  metric: MetricDefinition;
  value: number | null;
  previous?: number | null;
  symbol: string;
  generatedAt?: string | null;
  onDrillDown?: () => void;
  warning?: string | null;
}) {
  const delta = deltaLabel(value, previous ?? null);
  const up = value !== null && previous != null && value >= previous;
  return (
    <Card className="surface-panel neo-metric-card gap-0 transition-shadow hover:shadow-lift">
      <CardContent className="neo-card-pad">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-sm font-medium text-muted-foreground">{metric.name}</p>
          <div className="flex items-center gap-1">
            {metric.status !== "active" ? (
              <Badge variant="outline" className="text-[0.6rem] uppercase">
                {metric.status.replace("_", " ")}
              </Badge>
            ) : null}
            <MetricDefinitionDialog metric={metric} />
          </div>
        </div>
        <p className="neo-metric-value mt-2 text-foreground">
          {formatMetric(metric.unit, value, symbol)}
        </p>
        {value === null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            No qualifying records in this period — nothing is estimated.
          </p>
        ) : null}
        {delta ? (
          <p className={cn("mt-1 flex items-center gap-1 text-xs", up ? "text-success" : "text-destructive")}>
            {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {delta}
          </p>
        ) : null}
        {warning ? (
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-warning/15 px-2 py-1.5 text-xs text-on-tint-warning">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            {warning}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          <span className="inline-flex items-center gap-1 text-[0.68rem] text-muted-foreground">
            <Database className="size-3" />
            {metric.sources.slice(0, 2).join(", ")}
          </span>
          <FreshnessBadge freshness={metric.refresh} generatedAt={generatedAt ?? null} />
        </div>
        {onDrillDown ? (
          <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs" onClick={onDrillDown}>
            Drill down
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Chart frame — every chart carries title, unit, period, source
 * ------------------------------------------------------------------ */

export function ChartFrame({
  title,
  unit,
  period,
  source,
  children,
  actions,
  empty,
  series,
}: {
  title: string;
  unit: string;
  period: string;
  source: string;
  children: ReactNode;
  actions?: ReactNode;
  empty?: boolean;
  series?: ChartSeries[];
}) {
  // One frame for every chart in the product — title, unit/period subtitle,
  // legend, responsive plot height, designed empty state and a source line.
  return (
    <ChartCard
      title={title}
      subtitle={`${unit} · ${period}`}
      source={source}
      {...(actions ? { actions } : {})}
      {...(series ? { series } : {})}
      {...(empty ? { empty } : {})}
    >
      {children}
    </ChartCard>
  );
}

/**
 * Analytics shares the product-wide state language; `NotConfigured`,
 * `LoadingRows` and `ErrorState` keep their historic names and signatures.
 */
export { EmptyState, StateCard, sanitizeErrorMessage } from "@/components/common/StateSystem";

export function NotConfigured({ feature, detail }: { feature: string; detail?: string }) {
  return (
    <NotConfiguredState inline feature={feature} {...(detail ? { detail } : {})} />
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return <LoadingState rows={rows} />;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <SharedErrorState
      error={error}
      title="Analytics unavailable"
      inline
      {...(onRetry ? { onRetry } : {})}
    />
  );
}

/* ------------------------------------------------------------------ *
 * AI labelling — facts, calculations and interpretation never blur
 * ------------------------------------------------------------------ */

export function ClassificationBadge({ kind }: { kind: string }) {
  const map: Record<string, { label: string; tone: string }> = {
    fact: { label: "Verified fact", tone: "bg-success/15 text-success" },
    calculation: { label: "Calculation", tone: "bg-info/15 text-info" },
    forecast: { label: "Forecast", tone: "bg-warning/20 text-on-tint-warning" },
    interpretation: { label: "AI interpretation", tone: "bg-accent/20 text-accent-foreground" },
    recommendation: { label: "Recommendation", tone: "bg-primary-soft text-primary" },
  };
  const item = map[kind] ?? map["fact"]!;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[0.65rem] font-medium", item.tone)}>
      {item.label}
    </span>
  );
}

export function AiDisclosure({
  provider,
  modelVersion,
  dataPeriod,
  sources,
  confidence,
  gaps,
  owner,
}: {
  provider: string;
  modelVersion: string;
  dataPeriod: string;
  sources: string[];
  confidence: string;
  gaps?: string;
  owner?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <Sparkles className="size-3.5" />
        <span className="font-medium text-foreground">How this was produced</span>
        <span className="ml-auto">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <dl className="mt-2 space-y-1">
          <div>External AI used: {provider}</div>
          <div>Model / version: {modelVersion}</div>
          <div>Data period: {dataPeriod}</div>
          <div>Source metrics: {sources.join(", ") || "—"}</div>
          <div>Confidence: {confidence}</div>
          {gaps ? <div>Known data gaps: {gaps}</div> : null}
          <div>Human owner: {owner ?? "Requires human review before action"}</div>
        </dl>
      ) : null}
    </div>
  );
}

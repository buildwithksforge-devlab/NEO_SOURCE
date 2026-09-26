import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingsCategory } from "@/lib/settings-catalogue";
import type { SettingsStatusMap } from "@/lib/settings-status";
import {
  centreReadiness,
  domainReadiness,
  readinessLabel,
  readinessTone,
  type DomainReadiness,
} from "@/lib/settings-readiness";

/**
 * Configuration Centre landing.
 *
 * Every configuration domain is visible at once with an honest readiness
 * roll-up, so an operator can see the whole configuration surface of the
 * group before drilling into one domain. Nothing here invents a status: a
 * domain we cannot measure says so.
 */

const TONE_DOT: Record<string, string> = {
  attention: "bg-destructive",
  warning: "bg-warning",
  ready: "bg-success",
  neutral: "bg-muted-foreground/40",
};

const TONE_TEXT: Record<string, string> = {
  attention: "text-destructive",
  warning: "text-warning",
  ready: "text-muted-foreground",
  neutral: "text-muted-foreground",
};

function ReadinessBar({ readiness }: { readiness: DomainReadiness }) {
  if (readiness.measured === 0) return null;
  const pct = Math.round((readiness.configured / readiness.measured) * 100);
  return (
    <div
      className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`${readiness.configured} of ${readiness.measured} measured surfaces configured`}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all",
          readiness.attention > 0 ? "bg-destructive" : pct === 100 ? "bg-success" : "bg-primary",
        )}
        style={{ width: `${Math.max(pct, 2)}%` }}
      />
    </div>
  );
}

export function ConfigurationSummaryStrip({
  categories,
  statuses,
}: {
  categories: readonly SettingsCategory[];
  statuses?: SettingsStatusMap | undefined;
}) {
  const total = centreReadiness(categories, statuses);
  const items: { label: string; value: string; tone?: string }[] = [
    { label: "Domains", value: String(categories.length) },
    { label: "Configuration surfaces", value: String(total.total) },
    {
      label: "Configured",
      value: total.measured ? `${total.configured} of ${total.measured}` : "Not measured",
      tone: total.measured ? "ready" : "neutral",
    },
    {
      label: "Awaiting setup",
      value: total.measured ? String(total.needsSetup) : "—",
      tone: total.needsSetup > 0 ? "warning" : "neutral",
    },
    {
      label: "Need attention",
      value: total.measured ? String(total.attention) : "—",
      tone: total.attention > 0 ? "attention" : "neutral",
    },
  ];
  return (
    <div className="grid gap-px overflow-hidden rounded-xl border border-outline-subtle bg-outline-subtle sm:grid-cols-3 xl:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="bg-surface-2/60 px-4 py-3">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {item.label}
          </p>
          <p
            className={cn(
              "mt-1 truncate text-lg font-semibold text-foreground",
              item.tone && item.tone !== "neutral" ? TONE_TEXT[item.tone] : undefined,
            )}
          >
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}

export function ConfigurationOverview({
  categories,
  statuses,
  onOpen,
}: {
  categories: readonly SettingsCategory[];
  statuses?: SettingsStatusMap | undefined;
  onOpen: (key: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {categories.map((category) => {
        const readiness = domainReadiness(category, statuses);
        const tone = readinessTone(readiness);
        const Icon = category.icon;
        return (
          <button
            key={category.key}
            type="button"
            data-touch-target
            onClick={() => onOpen(category.key)}
            className={cn(
              "group flex min-h-[9rem] w-full min-w-0 flex-col rounded-xl border p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary-soft/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tone === "attention" ? "border-destructive/40 bg-destructive/5" : "border-outline-subtle",
            )}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft/50 text-primary">
                <Icon aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground">
                {category.title}
              </span>
              <ChevronRight
                aria-hidden
                className="mt-1 size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
              />
            </div>
            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {category.description}
            </p>
            <ReadinessBar readiness={readiness} />
            <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-3 text-[0.7rem] uppercase tracking-[0.08em]">
              <span className="text-muted-foreground/80">
                {readiness.total} surface{readiness.total === 1 ? "" : "s"}
              </span>
              <span className={cn("inline-flex items-center gap-1.5 font-medium", TONE_TEXT[tone])}>
                <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
                {readinessLabel(readiness)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Today, written as an editorial rather than a dashboard.
 *
 * One opening statement, one dominant intelligence story, two or three
 * supporting findings and everything routine folded away until it is asked
 * for. Presentation only: every figure arrives already derived from the
 * deterministic engine, and nothing here estimates a value.
 */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ChevronDown, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/common/DataDisplay";
import { EvidenceList } from "@/components/intelligence/EvidencePanel";
import { cn } from "@/lib/utils";
import { MODULE_LABEL, type Discovery, type Scope, type Severity } from "@/lib/intelligence-types";

const toneFor = (s: Severity) => (s === "critical" ? "destructive" : s === "warning" ? "warning" : "info");

const accentFor = (s: Severity) =>
  s === "critical" ? "border-l-destructive" : s === "warning" ? "border-l-warning" : "border-l-primary/50";

/** Time-of-day greeting from the reader's own clock — no stored preference. */
export function greetingFor(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** The opening statement: what today amounts to, in one sentence. */
export function EditorialOpening({
  attention,
  scope,
  greeting = greetingFor(),
}: {
  attention: number;
  scope: Scope;
  greeting?: string;
}) {
  return (
    <header data-testid="today-opening" className="neo-editorial-open min-w-0">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">{greeting}</p>
      <h2 className="mt-2 max-w-3xl text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl lg:text-4xl">
        {attention === 0 ? (
          <>Nothing needs your attention in this scope.</>
        ) : (
          <>
            <span className="tabular-nums">{attention}</span>{" "}
            {attention === 1 ? "thing needs" : "things need"} your attention today.
          </>
        )}
      </h2>
      <p className="mt-3 text-sm text-muted-foreground">
        {scope.propertyLabel} · {scope.from} → {scope.to}
        {scope.freshness ? ` · computed ${new Date(scope.freshness).toLocaleTimeString()}` : ""}
      </p>
    </header>
  );
}

/** The dominant story. One per screen, and only when a finding earns it. */
export function LeadStory({
  discovery,
  onInvestigate,
  chart,
}: {
  discovery: Discovery;
  onInvestigate?: (topic: string) => void;
  chart?: ReactNode;
}) {
  return (
    <article
      data-testid="lead-story"
      data-severity={discovery.severity}
      className={cn(
        "neo-lead-story min-w-0 rounded-3xl border border-outline-subtle border-l-[4px] p-5 sm:p-6",
        accentFor(discovery.severity),
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={toneFor(discovery.severity)}>{discovery.severity}</StatusPill>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {discovery.modules.map((m) => MODULE_LABEL[m]).join(" · ")}
        </p>
      </div>

      <h3 className="mt-3 text-pretty text-xl font-semibold leading-snug sm:text-2xl">{discovery.title}</h3>
      <p className="mt-2 max-w-2xl text-base leading-relaxed text-muted-foreground">{discovery.conclusion}</p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <dl className="grid grid-cols-2 gap-3 self-start">
          <div className="min-w-0 rounded-2xl bg-card/70 px-3 py-2.5">
            <dt className="truncate text-xs text-muted-foreground">Records affected</dt>
            <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{discovery.magnitude}</dd>
          </div>
          <div className="min-w-0 rounded-2xl bg-card/70 px-3 py-2.5">
            <dt className="truncate text-xs text-muted-foreground">Recorded value</dt>
            <dd className="mt-0.5 truncate text-2xl font-semibold tabular-nums">
              {discovery.impact
                ? `${discovery.impact.currency} ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(discovery.impact.value)}`
                : "—"}
            </dd>
          </div>
          <p className="col-span-2 text-xs text-muted-foreground">{discovery.impactNote}</p>
        </dl>
        {chart ? <div className="min-w-0">{chart}</div> : null}
      </div>

      <div className="mt-4">
        <EvidenceList evidence={discovery.evidence} />
      </div>

      <div data-action-cluster className="mt-4 flex flex-wrap items-center gap-2">
        {discovery.investigate && onInvestigate ? (
          <Button size="sm" onClick={() => onInvestigate(discovery.investigate as string)}>
            <ScanSearch className="size-4" /> Investigate with NEØ
          </Button>
        ) : null}
        {discovery.drillTo ? (
          <Button asChild size="sm" variant="outline">
            <Link to={discovery.drillTo}>
              See records <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** Two or three supporting findings, deliberately quieter than the lead. */
export function SupportingFindings({
  discoveries,
  onInvestigate,
}: {
  discoveries: Discovery[];
  onInvestigate?: (topic: string) => void;
}) {
  if (discoveries.length === 0) return null;
  return (
    <ol data-testid="supporting-findings" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {discoveries.map((d) => (
        <li
          key={d.id}
          className={cn(
            "neo-supporting flex min-w-0 flex-col gap-2 rounded-2xl border border-outline-subtle border-l-[3px] p-4",
            accentFor(d.severity),
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl font-semibold leading-none tabular-nums">{d.magnitude}</span>
            <StatusPill tone={toneFor(d.severity)}>{d.severity}</StatusPill>
          </div>
          <p className="min-w-0 text-sm font-semibold leading-snug">{d.title}</p>
          <p className="text-sm leading-snug text-muted-foreground">{d.conclusion}</p>
          <div data-action-cluster className="mt-auto flex flex-wrap gap-2 pt-1">
            {d.investigate && onInvestigate ? (
              <Button size="sm" variant="secondary" onClick={() => onInvestigate(d.investigate as string)}>
                Investigate
              </Button>
            ) : null}
            {d.drillTo ? (
              <Button asChild size="sm" variant="ghost">
                <Link to={d.drillTo}>See records</Link>
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Routine material: present, addressable, but out of the way until opened. */
export function RoutineDisclosure({
  label,
  count,
  children,
  defaultOpen = false,
}: {
  label: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details data-testid="routine-disclosure" className="neo-routine group rounded-2xl border border-outline-subtle" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm font-medium hover:bg-muted/40">
        <span className="min-w-0 truncate">
          {label}
          {count !== undefined ? <span className="ml-2 text-muted-foreground tabular-nums">{count}</span> : null}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-outline-subtle p-4">{children}</div>
    </details>
  );
}

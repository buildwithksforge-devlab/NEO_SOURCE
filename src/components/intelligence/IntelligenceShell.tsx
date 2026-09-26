/**
 * NEØ Intelligence presentation shell.
 *
 * Purely presentational: the hero band, the seven-section rail and the section
 * frames. No figure is produced here — every value shown is passed in from the
 * deterministic `neo_intelligence` payload.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NeoGlyph } from "@/components/brand/NeoGlyph";
import { StatusPill } from "@/components/common/DataDisplay";
import { cn } from "@/lib/utils";

export const INTELLIGENCE_SECTIONS = [
  { id: "executive-pulse", label: "Executive Pulse" },
  { id: "revenue-demand", label: "Revenue & Demand" },
  { id: "guest-experience", label: "Guest Experience" },
  { id: "operational-risk", label: "Operational Risk" },
  { id: "cost-inventory", label: "Cost & Inventory" },
  { id: "workforce", label: "Workforce" },
  { id: "recommendations", label: "Recommendations" },
] as const;

export type IntelligenceSectionId = (typeof INTELLIGENCE_SECTIONS)[number]["id"];

/** Signature NEØ band: brand gradient, glyph watermark, headline signals. */
export function IntelligenceHero({
  period,
  generatedAt,
  timezone,
  confidence,
  signals,
}: {
  period: string;
  generatedAt?: string | undefined;
  timezone?: string | undefined;
  confidence: "high" | "moderate" | "insufficient";
  signals: { label: string; value: string; hint?: string | undefined }[];
}) {
  return (
    <section
      data-testid="intelligence-hero"
      className="neo-intel-hero relative isolate overflow-hidden rounded-2xl border border-outline-subtle p-5 sm:p-6"
    >
      <NeoGlyph className="pointer-events-none absolute -right-6 -top-6 size-40 opacity-[0.06] sm:size-56" />
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-primary">
            NEØ Intelligence
          </p>
          <h2 className="mt-1 text-xl font-semibold leading-tight sm:text-2xl">Executive pulse</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Derived only from operational records inside your permitted properties for {period}.
            Nothing is estimated and no advisory changes live data.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill
            tone={
              confidence === "high" ? "success" : confidence === "moderate" ? "info" : "warning"
            }
          >
            {confidence === "high"
              ? "High confidence"
              : confidence === "moderate"
                ? "Moderate confidence"
                : "Insufficient history"}
          </StatusPill>
          {generatedAt ? (
            <span className="text-xs text-muted-foreground">
              Computed {new Date(generatedAt).toLocaleString()} {timezone ?? ""}
            </span>
          ) : null}
        </div>
      </div>

      <dl className="relative mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {signals.map((s) => (
          <div
            key={s.label}
            className="min-w-0 rounded-xl border border-outline-subtle bg-card/70 px-4 py-3 backdrop-blur-sm"
          >
            <dt className="truncate text-xs uppercase tracking-wide text-muted-foreground">
              {s.label}
            </dt>
            <dd className="mt-1 truncate text-2xl font-semibold tabular-nums">{s.value}</dd>
            {s.hint ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.hint}</p>
            ) : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Sticky rail that tracks which of the seven sections is in view. */
export function IntelligenceRail({ active }: { active: IntelligenceSectionId }) {
  return (
    <nav
      aria-label="Intelligence sections"
      data-testid="intelligence-rail"
      className="sticky top-2 z-10 -mx-1 overflow-x-auto rounded-xl border border-outline-subtle bg-card/85 px-1 py-1 backdrop-blur"
    >
      <ul className="flex min-w-max items-center gap-1">
        {INTELLIGENCE_SECTIONS.map((s, index) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? "true" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
                active === s.id
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <span className="tabular-nums opacity-60">{String(index + 1).padStart(2, "0")}</span>
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Section frame with the anchor id the rail scrolls to. */
export function IntelligenceSection({
  id,
  index,
  title,
  description,
  aside,
  children,
}: {
  id: IntelligenceSectionId;
  index: number;
  title: string;
  description: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} data-intel-section={id} className="scroll-mt-20 space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-outline-subtle pb-2">
        <div className="min-w-0">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {String(index).padStart(2, "0")} — NEØ Intelligence
          </p>
          <h3 className="text-base font-semibold sm:text-lg">{title}</h3>
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** Honest placeholder used when a section has no derivable records. */
export function AwaitingData({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="surface-quiet neo-card-pad rounded-xl text-sm">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-muted-foreground">{detail}</p>
    </div>
  );
}

/** Tracks the section currently in view so the rail can highlight it. */
export function useIntelligenceScrollSpy(enabled: boolean): IntelligenceSectionId {
  const [active, setActive] = useState<IntelligenceSectionId>("executive-pulse");
  const ref = useRef(active);
  ref.current = active;

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const nodes = INTELLIGENCE_SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (n): n is HTMLElement => Boolean(n),
    );
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = visible?.target.id as IntelligenceSectionId | undefined;
        if (id && id !== ref.current) setActive(id);
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: [0, 0.25] },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [enabled]);

  return active;
}

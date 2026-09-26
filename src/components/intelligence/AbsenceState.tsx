/**
 * Absence, explained.
 *
 * When something cannot be measured, NEØ says what the absence means and what
 * would make it measurable — it never fills the gap with an estimate and never
 * shows a bare "No data available".
 */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Telescope } from "lucide-react";

export function AbsenceState({
  title,
  meaning,
  coverageLabel = "Improve coverage",
  actions = [],
  children,
}: {
  /** e.g. "Guest sentiment isn't measurable yet". */
  title: string;
  /** Why it is absent, in plain language. */
  meaning: string;
  coverageLabel?: string;
  actions?: { label: string; to: string }[];
  children?: ReactNode;
}) {
  return (
    <section data-testid="absence-state" className="neo-absence rounded-2xl border border-dashed border-outline-subtle p-5">
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
          <Telescope className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            NEØ needs more data
          </p>
          <h4 className="mt-1 text-base font-semibold leading-snug">{title}</h4>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{meaning}</p>
        </div>
      </div>

      {actions.length > 0 ? (
        <div className="mt-4">
          <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">{coverageLabel}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {actions.map((a) => (
              <li key={a.to + a.label}>
                <Link
                  to={a.to}
                  className="inline-flex items-center rounded-full border border-outline-subtle px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/60"
                >
                  {a.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {children ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

/**
 * "What is going well" — the positive half of NEØ Intelligence.
 *
 * Every line comes from the same scoped payload and comparison window as the
 * risks: favourable material movements and clean control states. Nothing here
 * is encouragement written by the interface; if the records show nothing
 * positive, the panel says so plainly.
 */
import { Link } from "@tanstack/react-router";
import { TrendingUp } from "lucide-react";
import { StatusPill } from "@/components/common/DataDisplay";
import type { Positive } from "@/lib/intelligence-engine";

export function WhatsGoingWell({ positives }: { positives: Positive[] }) {
  if (positives.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing in this property and period improved materially, and no control state is fully
        clear. NEØ does not report progress it cannot evidence.
      </p>
    );
  }
  return (
    <ul data-testid="whats-going-well" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {positives.slice(0, 6).map((p) => (
        <li key={p.id} className="min-w-0 rounded-xl border border-outline-subtle bg-card/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 truncate text-xs uppercase tracking-wide text-muted-foreground">
              <TrendingUp className="size-3.5 shrink-0 text-primary" />
              {p.headline}
            </p>
            <StatusPill tone="success">Good</StatusPill>
          </div>
          <p className="mt-1 text-sm leading-snug">{p.detail}</p>
          {p.drillTo ? (
            <Link
              to={p.drillTo}
              className="mt-2 inline-block text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              See the records
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

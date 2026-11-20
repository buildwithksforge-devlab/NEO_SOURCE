/**
 * Work on a phone, opening on the job — not on a menu.
 *
 * A frontline employee picking up a phone mid-shift needs the work assigned to
 * them, not a navigation tree. This panel is shown above the dashboard on small
 * screens only, and is composed entirely from `neo_my_work`: the same
 * permission-scoped, property-scoped records the desktop My Work board reads.
 * It introduces no new source of truth and no destination the person's
 * permissions do not already reach.
 */
import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, ClipboardList } from "lucide-react";
import { attentionItems, orderWork, useMyWork, type WorkTone } from "@/lib/my-work";
import { useBranchScope } from "@/lib/branches";
import { cn } from "@/lib/utils";

const toneClass: Record<WorkTone, string> = {
  critical: "bg-destructive/10 text-destructive",
  warning: "bg-amber-500/10 text-amber-600",
  info: "bg-primary/10 text-primary",
  ok: "bg-muted text-muted-foreground",
};

export function MobileWorkToday() {
  const scope = useBranchScope();
  const branchId = scope.activeBranchId === "all" ? null : scope.activeBranchId;
  const myWork = useMyWork(branchId);

  const all = myWork.data?.items ?? [];
  const needing = attentionItems(all);
  const shown = (needing.length ? needing : orderWork(all)).slice(0, 3);

  if (myWork.data?.authorised === false) return null;

  return (
    <section className="neo-shift-overview mb-5 lg:hidden" aria-labelledby="shift-work-title">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <h2 id="shift-work-title" className="flex items-center gap-2 text-base font-semibold">
          <ClipboardList className="size-4 text-primary" aria-hidden /> My work
        </h2>
        <Link to="/my-work" className="inline-flex min-h-11 items-center gap-1 rounded-full px-2 text-sm font-semibold text-primary">
          View all <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      {myWork.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-sm">
          <p role="alert">My work couldn’t load.</p>
          <button type="button" className="min-h-11 font-semibold text-primary" onClick={() => void myWork.refetch()}>Retry</button>
        </div>
      ) : myWork.isPending ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground" role="status">Loading your work…</p>
      ) : shown.length === 0 ? (
        <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-primary" aria-hidden />
          Nothing is waiting on you.
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((item) => (
            <li key={item.id}>
              <Link
                to={item.route as never}
                className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              >
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold",
                    toneClass[item.tone],
                  )}
                >
                  {item.value}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}

    </section>
  );
}

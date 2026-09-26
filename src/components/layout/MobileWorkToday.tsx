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
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { attentionItems, orderWork, useMyWork, type WorkTone } from "@/lib/my-work";
import { useBranchScope } from "@/lib/branches";
import { useAuth } from "@/lib/auth";
import { greetingFor } from "@/lib/greeting";
import { cn } from "@/lib/utils";

const toneClass: Record<WorkTone, string> = {
  critical: "bg-destructive/10 text-destructive",
  warning: "bg-amber-500/10 text-amber-600",
  info: "bg-primary/10 text-primary",
  ok: "bg-muted text-muted-foreground",
};

export function MobileWorkToday() {
  const { profile } = useAuth();
  const scope = useBranchScope();
  const branchId = scope.activeBranchId === "all" ? null : scope.activeBranchId;
  const myWork = useMyWork(branchId);

  const all = myWork.data?.items ?? [];
  const needing = attentionItems(all);
  const shown = (needing.length ? needing : orderWork(all)).slice(0, 5);

  if (myWork.isLoading || myWork.data?.authorised === false) return null;

  return (
    <section className="mb-4 lg:hidden">
      <h1 className="text-lg font-semibold">{greetingFor(profile?.full_name ?? "there")}</h1>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {needing.length
          ? `${needing.length} thing${needing.length === 1 ? "" : "s"} need you${
              scope.activeBranch?.name ? ` at ${scope.activeBranch.name}` : ""
            }.`
          : "Nothing is waiting on you right now."}
      </p>

      {shown.length === 0 ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-primary" aria-hidden />
          You are clear for now.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {shown.map((item) => (
            <li key={item.id}>
              <Link
                to={item.route as never}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5"
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
                  <span className="block truncate text-sm font-medium">{item.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        to="/my-work"
        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary"
      >
        All my work <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </section>
  );
}

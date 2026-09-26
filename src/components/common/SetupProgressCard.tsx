import { CheckCircle2, Circle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useTenant } from "@/lib/tenant";
import { cn } from "@/lib/utils";

/**
 * Readiness summary for workspace configuration.
 *
 * Executive first: the percentage and completed/outstanding counts lead, the
 * item list supports. Nothing here is a call to action — the rows are status,
 * not buttons.
 */
export function SetupProgressCard({ compact = false }: { compact?: boolean }) {
  const { setupProgress } = useTenant();
  const done = setupProgress.items.filter((i) => i.done).length;
  const total = setupProgress.items.length;
  const outstanding = total - done;

  return (
    <section className="surface-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Setup progress
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {outstanding === 0
              ? "Every configuration step on this checklist is complete."
              : `${outstanding} step${outstanding === 1 ? "" : "s"} outstanding before white-label configuration is complete.`}
          </p>
        </div>
        <div className="text-right">
          <p className="numeric text-3xl font-semibold leading-none tracking-tight text-foreground">
            {setupProgress.overall}%
          </p>
          <p className="numeric mt-1.5 text-xs text-muted-foreground">
            {done} of {total} complete
          </p>
        </div>
      </div>

      <Progress value={setupProgress.overall} className="mt-4 h-1.5" />

      <ul
        className={cn(
          "mt-5 space-y-2.5 border-t border-outline-subtle pt-4",
          compact && "max-h-56 overflow-y-auto",
        )}
      >
        {setupProgress.items.map((item) => (
          <li key={item.key} className="flex items-start gap-2.5 text-sm">
            {item.done ? (
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
            )}
            <span className="min-w-0">
              <span
                className={cn(
                  "block font-medium",
                  item.done ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {item.label}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

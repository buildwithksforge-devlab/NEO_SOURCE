/**
 * Department dashboard — the figures of the person's own department.
 *
 * A receptionist sees arrivals, a chef sees tickets, a storekeeper sees stock,
 * a housekeeper sees rooms — because those are the blocks `neo_my_work`
 * released to them. Presentation only: every count arrives already
 * permission-scoped from the database.
 */
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { MODULE_LABEL } from "@/lib/department-ask";
import { orderWork, type WorkItem } from "@/lib/my-work";

const TONE_CLASS: Record<string, string> = {
  critical: "border-destructive/40 bg-destructive/5",
  warning: "border-warning/40 bg-warning/5",
  info: "border-outline-subtle bg-surface-2/60",
  ok: "border-outline-subtle bg-surface-2/40",
};

export function DepartmentBoard({ items }: { items: WorkItem[] }) {
  const modules = Array.from(new Set(items.map((i) => i.module)));
  if (modules.length === 0) return null;

  return (
    <div className="space-y-4" data-testid="department-board">
      {modules.map((module) => {
        const scoped = orderWork(items.filter((i) => i.module === module));
        return (
          <SectionCard
            key={module}
            title={MODULE_LABEL[module] ?? module}
            description="Live figures from your department's records in the property you are working in."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {scoped.map((item) => (
                <Link
                  key={item.id}
                  to={item.route}
                  className={`group flex min-w-0 flex-col gap-1 rounded-xl border p-3 transition-colors hover:border-primary/40 ${
                    TONE_CLASS[item.tone] ?? TONE_CLASS["info"]
                  }`}
                >
                  <span className="text-2xl font-semibold tabular-nums">{Number(item.value)}</span>
                  <span className="text-sm font-medium leading-snug">{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.detail}</span>
                  <span className="mt-1 inline-flex items-center gap-1 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
                    Open <ArrowRight className="size-3" aria-hidden />
                  </span>
                </Link>
              ))}
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}

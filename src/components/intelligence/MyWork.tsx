/**
 * My Work — what needs this person's attention, in the property the header is
 * working in. Presentation only: every count arrives already permission-scoped
 * from the database, and nothing here estimates or invents a figure.
 */
import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { SectionCard, SubsectionHeading } from "@/components/common/DataDisplay";
import { cn } from "@/lib/utils";
import { attentionItems, orderWork, type WorkItem } from "@/lib/my-work";

const TONE_CLASS: Record<string, string> = {
  critical: "border-destructive/40 bg-destructive/5",
  warning: "border-warning/40 bg-warning/5",
  info: "border-outline-subtle bg-surface-2/60",
  ok: "border-outline-subtle bg-surface-2/40",
};

function WorkTile({ item }: { item: WorkItem }) {
  return (
    <Link
      to={item.route}
      className={cn(
        "group flex min-w-0 flex-col gap-1 rounded-xl border p-3 transition-colors hover:border-primary/40",
        TONE_CLASS[item.tone] ?? TONE_CLASS["info"],
      )}
    >
      <span className="text-2xl font-semibold tabular-nums">{Number(item.value)}</span>
      <span className="text-sm font-medium leading-snug">{item.label}</span>
      <span className="text-xs text-muted-foreground">{item.detail}</span>
      <span className="mt-1 inline-flex items-center gap-1 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
        Open <ArrowRight className="size-3" aria-hidden />
      </span>
    </Link>
  );
}

/**
 * The opening line NEØ speaks: only the items that genuinely need attention.
 * When nothing does, it says so rather than filling the space.
 */
export function MyWorkBoard({
  items,
  propertyLabel,
  today,
  lensNote,
}: {
  items: WorkItem[];
  propertyLabel: string;
  today?: string | undefined;
  lensNote?: string | undefined;
}) {
  const attention = attentionItems(items);
  const rest = orderWork(items).filter((i) => !attention.includes(i));

  return (
    <div className="space-y-4" data-testid="my-work">
      <SectionCard
        title="My work"
        description={`Working in ${propertyLabel}${today ? ` · ${today}` : ""}. ${
          lensNote ?? "Only the areas your permissions already reach are shown."
        }`}
      >
        {attention.length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-outline-subtle bg-surface-2/50 p-4 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            Nothing in your areas needs attention right now.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {attention.map((i) => (
              <WorkTile key={i.id} item={i} />
            ))}
          </div>
        )}
      </SectionCard>

      {rest.length > 0 ? (
        <SectionCard title="Everything else in my areas" description="Clear, or nothing recorded.">
          <SubsectionHeading title="Currently clear" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rest.map((i) => (
              <WorkTile key={i.id} item={i} />
            ))}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

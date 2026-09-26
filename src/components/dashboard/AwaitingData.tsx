import { usePagePermitted } from "@/components/common/PermittedLink";
import { Link } from "@tanstack/react-router";
import { CircleDashed } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StateCard } from "@/components/common/StateSystem";

/**
 * Rendered wherever a widget depends on an operational module that has not been
 * built yet. Phase 3 never invents numbers — it states the data source is pending.
 */
export function AwaitingData({
  title,
  note = "Awaiting operational data",
  className,
}: {
  title: string;
  note?: string;
  className?: string;
}) {
  return (
    <Card
      className={cn(
        "surface-panel border-dashed bg-muted/30 py-5 shadow-none gap-0",
        className,
      )}
    >
      <CardContent className="px-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
        </div>
        <p className="mt-3 text-lg font-semibold text-muted-foreground">Awaiting data</p>
        <p className="mt-1 text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

export function EmptyState({ message, to, cta }: { message: string; to?: string; cta?: string }) {
  // A call to action must never lead into a page the reader cannot open.
  const permitted = usePagePermitted();
  const allowed = to ? permitted(to) : false;
  return (
    <StateCard
      variant="empty"
      title="Nothing to show yet"
      description={message}
      {...(to && cta && allowed
        ? {
            action: (
              <Button asChild size="sm" variant="outline">
                <Link to={to}>{cta}</Link>
              </Button>
            ),
          }
        : {})}
    />
  );
}

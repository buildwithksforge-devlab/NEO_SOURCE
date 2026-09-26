import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { usePagePermitted } from "@/components/common/PermittedLink";
import { cn } from "@/lib/utils";

/**
 * Record breadcrumbs and related-record links.
 *
 * A mature system tells the operator where they are and what this record is
 * attached to:
 *
 *   Front Office → In-house → Ruth Okoth → Folio FOL-00231
 *
 * and then offers the reservation, room and guest as first-class links rather
 * than bare identifiers that jump somewhere unexplained. Any step whose
 * destination the user may not open degrades to plain text — the trail stays
 * complete and honest, the link simply is not offered.
 */
export type Crumb = {
  label: string;
  to?: string | undefined;
};

export function RecordBreadcrumbs({
  trail,
  className,
}: {
  trail: Crumb[];
  className?: string;
}) {
  const permitted = usePagePermitted();
  if (!trail.length) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          const linkable = Boolean(crumb.to) && !last && permitted(crumb.to!);
          return (
            <Fragment key={`${crumb.label}-${index}`}>
              <li className="min-w-0">
                {linkable ? (
                  <Link
                    to={crumb.to!}
                    className="max-w-[16rem] truncate rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={crumb.label}
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    className={cn("max-w-[16rem] truncate", last && "font-medium text-foreground")}
                    title={crumb.label}
                    {...(last ? { "aria-current": "page" as const } : {})}
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
              {last ? null : (
                <li aria-hidden className="text-muted-foreground/60">
                  <ChevronRight className="size-3" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

export type RelatedRecord = {
  /** What the related record is — "Reservation", "Room", "Guest". */
  kind: string;
  /** Its identifier or name, shown verbatim so it can be read aloud. */
  label: string;
  to?: string | undefined;
};

/**
 * Contextual relationships for a record. Every chip states its kind in text,
 * so the relationship is never carried by colour or position alone.
 */
export function RelatedRecords({
  records,
  className,
}: {
  records: RelatedRecord[];
  className?: string;
}) {
  const permitted = usePagePermitted();
  const shown = records.filter((record) => record.label);
  if (!shown.length) return null;

  return (
    <ul className={cn("flex flex-wrap items-center gap-2", className)} aria-label="Related records">
      {shown.map((record) => {
        const linkable = Boolean(record.to) && permitted(record.to!);
        const body = (
          <>
            <span className="text-muted-foreground">{record.kind}</span>
            <span className="font-medium text-foreground">{record.label}</span>
          </>
        );
        return (
          <li key={`${record.kind}-${record.label}`} className="min-w-0">
            {linkable ? (
              <Link
                to={record.to!}
                className="inline-flex min-h-[2rem] items-center gap-2 rounded-md border border-border/70 px-2.5 py-1 text-xs transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </Link>
            ) : (
              <span className="inline-flex min-h-[2rem] items-center gap-2 rounded-md border border-dashed border-border/60 px-2.5 py-1 text-xs">
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

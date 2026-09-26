/**
 * Lane Board — status lanes for records with a defined lifecycle (POS orders,
 * production, delivery tasks, procurement requests, incidents).
 *
 * Read-only composition: the board renders whatever lanes the caller derives
 * from the module's own status model. It does not own lifecycle rules and does
 * not move records; actions stay on the card the caller supplies.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { TONE_BORDER, TONE_TINT, type Tone } from "@/lib/tone";

export type Lane<T> = {
  id: string;
  label: string;
  tone?: Tone;
  hint?: string;
  items: T[];
};

export function LaneBoard<T>({
  lanes,
  renderItem,
  getKey,
  emptyLaneLabel = "Nothing here",
  className,
}: {
  lanes: Lane<T>[];
  renderItem: (item: T) => ReactNode;
  getKey: (item: T) => string;
  emptyLaneLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Lanes scroll horizontally on phone/tablet rather than squashing.
        "neo-scroll-x -mx-1 flex min-w-0 items-start gap-3 px-1 pb-1",
        className,
      )}
    >
      {lanes.map((lane) => (
        <section
          key={lane.id}
          aria-label={lane.label}
          className="surface-quiet flex w-[17rem] shrink-0 flex-col rounded-2xl p-2 sm:w-[19rem]"
        >
          <header
            className={cn(
              "mb-2 flex items-center justify-between gap-2 rounded-xl px-2.5 py-1.5",
              TONE_TINT[lane.tone ?? "default"],
            )}
          >
            <div className="min-w-0">
              <p className="neo-line-1 text-sm font-semibold">{lane.label}</p>
              {lane.hint ? (
                <p className="neo-line-1 text-xs opacity-80">{lane.hint}</p>
              ) : null}
            </div>
            <span className="shrink-0 text-sm font-semibold tabular-nums">{lane.items.length}</span>
          </header>

          <div className="flex max-h-[70vh] min-w-0 flex-col gap-2 overflow-y-auto">
            {lane.items.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
                {emptyLaneLabel}
              </p>
            ) : (
              lane.items.map((item) => (
                <div
                  key={getKey(item)}
                  className={cn(
                    "surface-raised min-w-0 rounded-xl border p-3",
                    TONE_BORDER[lane.tone ?? "default"],
                  )}
                >
                  {renderItem(item)}
                </div>
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

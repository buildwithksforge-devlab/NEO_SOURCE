/**
 * Room readiness presentation contract.
 *
 * Housekeeping readiness is a lifecycle, not a boolean, and two of its states
 * are routinely confused on the floor:
 *
 *   • "Clean — awaiting inspection": the room has been cleaned but a
 *     supervisor has not released it. It must NOT be sold yet.
 *   • "Ready to sell": inspected and released. Front Office may allocate it.
 *
 * Every surface that shows readiness renders it through this contract, so the
 * distinction is carried by an icon AND a label AND a controlled semantic
 * tone — never by colour alone and never by text alone.
 */
import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  Brush,
  ListChecks,
  RotateCcw,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { canonicalHousekeepingStatus } from "@/lib/operations";
import { TONE_BORDER, TONE_TINT, type Tone } from "@/lib/tone";

export type ReadinessPresentation = {
  /** Canonical readiness key. */
  key: string;
  /** Distinct, unambiguous operator wording. */
  label: string;
  /** Short wording for dense matrices where the full label cannot fit. */
  short: string;
  icon: LucideIcon;
  tone: Tone;
  /** Whether Front Office may allocate the room in this state. */
  sellable: boolean;
  /** Plain-language explanation, surfaced as a title/description. */
  meaning: string;
};

export const ROOM_READINESS: Record<string, ReadinessPresentation> = {
  dirty: {
    key: "dirty",
    label: "Vacant dirty",
    short: "Dirty",
    icon: Trash2,
    tone: "destructive",
    sellable: false,
    meaning: "Not cleaned. Housekeeping has yet to service the room.",
  },
  cleaning_queued: {
    key: "cleaning_queued",
    label: "Cleaning queued",
    short: "Queued",
    icon: ListChecks,
    tone: "info",
    sellable: false,
    meaning: "A cleaning job exists but nobody has started it.",
  },
  cleaning_in_progress: {
    key: "cleaning_in_progress",
    label: "Cleaning in progress",
    short: "Cleaning",
    icon: Brush,
    tone: "info",
    sellable: false,
    meaning: "A housekeeper is working in the room now.",
  },
  awaiting_inspection: {
    key: "awaiting_inspection",
    label: "Clean — awaiting inspection",
    short: "Clean",
    icon: Sparkles,
    tone: "warning",
    sellable: false,
    meaning: "Cleaned but not yet released by a supervisor. Do not sell it yet.",
  },
  rework_required: {
    key: "rework_required",
    label: "Rework required",
    short: "Rework",
    icon: RotateCcw,
    tone: "warning",
    sellable: false,
    meaning: "Inspection failed. The room goes back to housekeeping.",
  },
  ready: {
    key: "ready",
    label: "Ready to sell",
    short: "Ready",
    icon: BadgeCheck,
    tone: "success",
    sellable: true,
    meaning: "Inspected and released. Front Office may allocate the room.",
  },
  out_of_service: {
    key: "out_of_service",
    label: "Out of service",
    short: "Out",
    icon: Wrench,
    tone: "default",
    sellable: false,
    meaning: "Withdrawn from inventory. Readiness does not apply.",
  },
};

const UNKNOWN: ReadinessPresentation = {
  key: "unknown",
  label: "Readiness not recorded",
  short: "Unknown",
  icon: ListChecks,
  tone: "default",
  sellable: false,
  meaning: "No readiness has been recorded for this room.",
};

export function readinessPresentation(value: unknown): ReadinessPresentation {
  if (value === null || value === undefined || value === "") return UNKNOWN;
  return ROOM_READINESS[canonicalHousekeepingStatus(value)] ?? UNKNOWN;
}


/**
 * Readiness badge. `compact` keeps the icon and the short word for dense
 * matrices; the full wording stays reachable through the title and the
 * accessible label so nothing is lost when space is.
 */
export function RoomReadinessBadge({
  status,
  compact = false,
  className,
}: {
  status: unknown;
  compact?: boolean;
  className?: string;
}) {
  const p = readinessPresentation(status);
  const Icon = p.icon;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_TINT[p.tone],
        TONE_BORDER[p.tone],
        className,
      )}
      title={`${p.label} — ${p.meaning}`}
      aria-label={p.label}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{compact ? p.short : p.label}</span>
    </span>
  );
}

/** Legend so the icon language is learnable rather than guessed. */
export function RoomReadinessLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {Object.values(ROOM_READINESS).map((p) => (
        <RoomReadinessBadge key={p.key} status={p.key} />
      ))}
    </div>
  );
}

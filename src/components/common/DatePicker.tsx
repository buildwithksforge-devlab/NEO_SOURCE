import { useMemo, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDensity } from "@/lib/density";
import { cn } from "@/lib/utils";

/**
 * NEØ date language.
 *
 * One shared picker for every staff search box, filter and form field so a
 * date never looks or behaves differently between modules. The value contract
 * is deliberately identical to the native date input it replaces —
 * an ISO `YYYY-MM-DD` string (or "") — so existing query params, RPC payloads
 * and validation keep working untouched.
 */

export type IsoDate = string;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Parses `YYYY-MM-DD` as a *local* date so the calendar never drifts a day. */
export function parseIso(value: string | null | undefined): Date | undefined {
  if (!value || !ISO.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Formats a Date back to the stored `YYYY-MM-DD` contract. */
export function toIso(date: Date | undefined | null): IsoDate {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDisplay(value: string | null | undefined): string {
  const date = parseIso(value);
  if (!date) return "";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function nightsBetween(from: string, to: string): number {
  const a = parseIso(from);
  const b = parseIso(to);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

function addDays(base: Date, days: number) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

export type QuickChoice = "today" | "tomorrow" | "this-week" | "next-7" | "this-month";

const QUICK_LABELS: Record<QuickChoice, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  "this-week": "This week",
  "next-7": "Next 7 days",
  "this-month": "This month",
};

/** Resolves a quick choice into the range it represents (single pickers use `from`). */
export function quickRange(choice: QuickChoice, today = new Date()): { from: string; to: string } {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  switch (choice) {
    case "today":
      return { from: toIso(base), to: toIso(base) };
    case "tomorrow": {
      const t = addDays(base, 1);
      return { from: toIso(t), to: toIso(t) };
    }
    case "this-week": {
      // ISO week — Monday start.
      const offset = (base.getDay() + 6) % 7;
      const start = addDays(base, -offset);
      return { from: toIso(start), to: toIso(addDays(start, 6)) };
    }
    case "next-7":
      return { from: toIso(base), to: toIso(addDays(base, 6)) };
    case "this-month": {
      const start = new Date(base.getFullYear(), base.getMonth(), 1);
      const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      return { from: toIso(start), to: toIso(end) };
    }
  }
}

function useTriggerHeight() {
  const { density } = useDensity();
  // Touch mode keeps the accessibility floor of 44px.
  return density === "touch" ? "h-11" : density === "compact" ? "h-8" : "h-9";
}

const calendarClassNames = {
  today: "bg-primary/10 text-primary font-semibold rounded-md",
  selected: "rounded-md",
  day: "rounded-md",
} as const;

/* ------------------------------- single date ------------------------------ */

export function NeoDatePicker({
  value,
  onChange,
  id,
  placeholder = "Select date",
  className,
  disabled,
  clearable = true,
  quick,
  min,
  max,
  ariaLabel,
}: {
  value: string | null | undefined;
  onChange: (value: IsoDate) => void;
  id?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  clearable?: boolean;
  quick?: readonly QuickChoice[];
  min?: string | undefined;
  max?: string | undefined;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const height = useTriggerHeight();
  const selected = parseIso(value);
  const label = formatDisplay(value);

  const disabledMatcher = useMemo(() => {
    const before = parseIso(min);
    const after = parseIso(max);
    const matchers: Array<{ before: Date } | { after: Date }> = [];
    if (before) matchers.push({ before });
    if (after) matchers.push({ after });
    return matchers;
  }, [min, max]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("relative w-full", className)}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={ariaLabel ?? placeholder}
            data-slot="neo-date-trigger"
            className={cn(
              "w-full min-w-0 justify-start gap-2 px-3 font-normal",
              height,
              !label && "text-muted-foreground",
              clearable && label && "pr-9",
            )}
          >
            <CalendarDays className="size-4 shrink-0 opacity-70" aria-hidden />
            <span className="min-w-0 truncate">{label || placeholder}</span>
          </Button>
        </PopoverTrigger>
        {clearable && label && !disabled ? (
          <button
            type="button"
            aria-label="Clear date"
            onClick={() => onChange("")}
            className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
        {quick?.length ? (
          <div className="flex flex-wrap gap-1.5 border-b border-border p-2">
            {quick.map((q) => (
              <Button
                key={q}
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2.5 text-xs"
                onClick={() => {
                  onChange(quickRange(q).from);
                  setOpen(false);
                }}
              >
                {QUICK_LABELS[q]}
              </Button>
            ))}
          </div>
        ) : null}
        <Calendar
          mode="single"
          autoFocus
          selected={selected}
          {...(selected ? { defaultMonth: selected } : {})}
          disabled={disabledMatcher}
          classNames={calendarClassNames}
          onSelect={(d) => {
            onChange(toIso(d));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/* -------------------------------- date range ------------------------------ */

export function NeoDateRangePicker({
  from,
  to,
  onChange,
  className,
  disabled,
  quick,
  placeholder = "Select dates",
  fromLabel = "From",
  toLabel = "To",
  showNights = false,
  ariaLabel,
}: {
  from: string | null | undefined;
  to: string | null | undefined;
  onChange: (range: { from: IsoDate; to: IsoDate }) => void;
  className?: string;
  disabled?: boolean;
  quick?: readonly QuickChoice[];
  placeholder?: string;
  fromLabel?: string;
  toLabel?: string;
  /** Hospitality stays show the night count between the two dates. */
  showNights?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const height = useTriggerHeight();
  const selected: DateRange | undefined = parseIso(from)
    ? { from: parseIso(from)!, ...(parseIso(to) ? { to: parseIso(to)! } : {}) }
    : undefined;

  const nights = from && to ? nightsBetween(from, to) : 0;
  const label = from
    ? `${formatDisplay(from)}${to ? ` → ${formatDisplay(to)}` : ""}`
    : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel ?? placeholder}
          data-slot="neo-date-range-trigger"
          className={cn(
            "w-full min-w-0 justify-start gap-2 px-3 font-normal",
            height,
            !label && "text-muted-foreground",
            className,
          )}
        >
          <CalendarDays className="size-4 shrink-0 opacity-70" aria-hidden />
          <span className="min-w-0 truncate">{label || placeholder}</span>
          {showNights && nights > 0 ? (
            <span className="ml-auto shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[0.68rem] font-medium text-primary">
              {nights} {nights === 1 ? "night" : "nights"}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{fromLabel}</span>{" "}
            {formatDisplay(from) || "—"}
          </span>
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{toLabel}</span>{" "}
            {formatDisplay(to) || "—"}
          </span>
        </div>
        {quick?.length ? (
          <div className="flex flex-wrap gap-1.5 border-b border-border p-2">
            {quick.map((q) => (
              <Button
                key={q}
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2.5 text-xs"
                onClick={() => {
                  onChange(quickRange(q));
                  setOpen(false);
                }}
              >
                {QUICK_LABELS[q]}
              </Button>
            ))}
          </div>
        ) : null}
        <Calendar
          mode="range"
          autoFocus
          numberOfMonths={1}
          {...(selected ? { selected } : {})}
          {...(selected?.from ? { defaultMonth: selected.from } : {})}
          classNames={calendarClassNames}
          onSelect={(range) => {
            const next = { from: toIso(range?.from), to: toIso(range?.to) };
            onChange(next);
            if (next.from && next.to) setOpen(false);
          }}
        />
        {showNights && nights > 0 ? (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {nights} {nights === 1 ? "night" : "nights"} selected
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

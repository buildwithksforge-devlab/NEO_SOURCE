import { useEffect, useState } from "react";
import { useActiveTimezone } from "@/lib/branches";

const ZONE_LABELS: Record<string, string> = {
  "Africa/Nairobi": "EAT",
  "Africa/Kampala": "EAT",
  "Africa/Dar_es_Salaam": "EAT",
  "Africa/Addis_Ababa": "EAT",
  "Africa/Mogadishu": "EAT",
};

/**
 * Compact workspace clock parts: `THU 27 AUG '26` plus `12:03 PM`.
 * Uppercase three-letter day and month, two-digit year, no seconds.
 */
export function clockParts(date: Date, timeZone: string) {
  const fmt = (options: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).formatToParts(date);
    } catch {
      return new Intl.DateTimeFormat("en-GB", options).formatToParts(date);
    }
  };
  const dateParts = fmt({ weekday: "short", day: "2-digit", month: "short", year: "2-digit" });
  const timeParts = fmt({ hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
  const pick = (list: Intl.DateTimeFormatPart[], type: string) =>
    list.find((p) => p.type === type)?.value ?? "";

  const weekday = pick(dateParts, "weekday").slice(0, 3).toUpperCase();
  const day = pick(dateParts, "day");
  const month = pick(dateParts, "month").slice(0, 3).toUpperCase();
  const year = pick(dateParts, "year").slice(-2);

  return {
    // e.g. THU 27 AUG '26
    date: `${weekday} ${day} ${month} '${year}`,
    // e.g. 12:03 PM — no seconds
    time: `${pick(timeParts, "hour")}:${pick(timeParts, "minute")} ${pick(timeParts, "dayPeriod").toUpperCase()}`,
    zone: ZONE_LABELS[timeZone] ?? pick(timeParts, "timeZoneName"),
  };
}

/**
 * Live workspace clock. Uses the active property timezone, falling back to the
 * organization timezone and finally Africa/Nairobi. Rendered client-side only
 * so server and client markup can never disagree.
 */
export function LiveClock({ className }: { className?: string }) {
  const timeZone = useActiveTimezone();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <div className="hidden min-w-0 md:block" aria-hidden />;

  const p = clockParts(now, timeZone);

  return (
    <div
      data-live-clock
      className={
        "hidden min-w-0 shrink-0 items-baseline gap-2 whitespace-nowrap md:flex " + (className ?? "")
      }
    >
      <span className="text-[0.68rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {p.date}
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{p.time}</span>
      <span className="text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground/70">
        {p.zone}
      </span>
    </div>
  );
}

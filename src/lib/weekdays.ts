/**
 * Canonical weekday representation for the whole platform.
 *
 * ISO-8601 weekday integers (Monday = 1 … Sunday = 7) are the single stored
 * form. Any UI label ("MON"), legacy string ("sat", "saturday") or numeric
 * string is mapped to that integer before it reaches the database, so a rate
 * plan, availability query, reservation quote and report can never disagree
 * about what "Saturday" means.
 */

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const ISO_WEEKDAYS: { value: IsoWeekday; short: string; label: string }[] = [
  { value: 1, short: "MON", label: "Monday" },
  { value: 2, short: "TUE", label: "Tuesday" },
  { value: 3, short: "WED", label: "Wednesday" },
  { value: 4, short: "THU", label: "Thursday" },
  { value: 5, short: "FRI", label: "Friday" },
  { value: 6, short: "SAT", label: "Saturday" },
  { value: 7, short: "SUN", label: "Sunday" },
];

const ALIASES: Record<string, IsoWeekday> = {
  mon: 1, monday: 1, m: 1,
  tue: 2, tues: 2, tuesday: 2, tu: 2,
  wed: 3, weds: 3, wednesday: 3, w: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, th: 4,
  fri: 5, friday: 5, f: 5,
  sat: 6, saturday: 6, sa: 6,
  sun: 7, sunday: 7, su: 7,
};

/** Returns the canonical ISO weekday, or null when the value is unrecognised. */
export function normalizeWeekday(value: unknown): IsoWeekday | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7) {
    return value as IsoWeekday;
  }
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (!raw) return null;
    if (/^[1-7]$/.test(raw)) return Number(raw) as IsoWeekday;
    // Sunday-zero legacy inputs (0 = Sunday) map onto ISO 7.
    if (raw === "0") return 7;
    return ALIASES[raw] ?? ALIASES[raw.slice(0, 3)] ?? null;
  }
  return null;
}

/**
 * Normalises a mixed list into sorted, unique ISO weekdays.
 * Throws with the offending values so the caller can surface a truthful
 * field-level message rather than letting Postgres reject the payload.
 */
export function normalizeWeekdays(values: readonly unknown[] | null | undefined): IsoWeekday[] {
  if (!values || values.length === 0) return [];
  const out = new Set<IsoWeekday>();
  const bad: string[] = [];
  for (const v of values) {
    const day = normalizeWeekday(v);
    if (day === null) bad.push(String(v));
    else out.add(day);
  }
  if (bad.length) {
    throw new Error(`Unrecognised weekday value(s): ${bad.join(", ")}. Use Monday (1) through Sunday (7).`);
  }
  return [...out].sort((a, b) => a - b);
}

export function weekdayShort(value: IsoWeekday): string {
  return ISO_WEEKDAYS.find((d) => d.value === value)?.short ?? String(value);
}

export function weekdayLabel(value: IsoWeekday): string {
  return ISO_WEEKDAYS.find((d) => d.value === value)?.label ?? String(value);
}

/** ISO weekday of a `YYYY-MM-DD` date (matches Postgres `extract(isodow …)`). */
export function isoWeekdayOf(date: string | Date): IsoWeekday {
  const d = typeof date === "string" ? new Date(`${date}T00:00:00`) : date;
  const js = d.getDay();
  return (js === 0 ? 7 : js) as IsoWeekday;
}

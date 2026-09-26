/**
 * The audit trail is stored month by month. A read without a date bound has to
 * touch every month that has ever existed, which gets slower every month and
 * never gets faster again. So every audit read carries a window, and screens
 * that let a person widen it pass their own dates instead.
 */
export const AUDIT_DEFAULT_WINDOW_DAYS = 180;

/** ISO timestamp for the start of the default audit window. */
export function auditWindowFrom(days: number = AUDIT_DEFAULT_WINDOW_DAYS, now: Date = new Date()): string {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

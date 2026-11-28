/**
 * Calendar date in Kenya's business timezone.
 *
 * POS business dates must not depend on the computer's
 * local timezone or the UTC date.
 */
export function kenyaBusinessDate(
  instant: Date = new Date(),
): string {
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("Invalid reporting instant.");
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;

  const year = value("year");
  const month = value("month");
  const day = value("day");

  if (!year || !month || !day) {
    throw new Error("Could not determine Kenya business date.");
  }

  return `${year}-${month}-${day}`;
}

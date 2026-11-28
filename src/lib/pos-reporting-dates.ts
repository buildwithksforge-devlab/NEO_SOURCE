/**
 * Validates real calendar dates used in NE? POS reporting.
 *
 * Dates must use YYYY-MM-DD.
 * Validation does not convert between time zones.
 */
export function isValidPosReportingDate(
  value: unknown,
): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const parts = value.split("-");

  if (parts.length !== 3) {
    return false;
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1
  ) {
    return false;
  }

  const isLeapYear =
    year % 4 === 0 &&
    (year % 100 !== 0 || year % 400 === 0);

  const daysInMonth =
    month === 2
      ? isLeapYear
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;

  return day <= daysInMonth;
}

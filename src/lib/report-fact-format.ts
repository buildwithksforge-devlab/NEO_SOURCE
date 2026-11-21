/** Display authoritative report facts without inventing zeroes or currencies. */
export function formatReportFact(value: unknown, kind: string, currency: string): string {
  if (value === null || value === undefined || value === "") return "Awaiting data";
  if (kind !== "money" && kind !== "percent" && kind !== "count") return String(value);
  if ((typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && value.trim() === "")
    || !Number.isFinite(Number(value))) return "Invalid data — review source";
  const numeric = Number(value);
  if (kind === "money") {
    if (!/^[A-Z]{3}$/.test(currency)) return "Currency not verified";
    return `${currency} ${new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(numeric)}`;
  }
  if (kind === "percent") return `${numeric.toFixed(1)}%`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(numeric);
}

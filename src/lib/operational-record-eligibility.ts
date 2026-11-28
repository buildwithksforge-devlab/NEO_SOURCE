type OperationalRecord = Record<string, unknown>;

const excludedStatuses = new Set([
  "archived",
  "inactive",
  "disabled",
  "retired",
  "deleted",
  "terminated",
  "suspended",
]);

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isOperationallyEnabled(
  value: unknown,
): boolean {

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const record = value as OperationalRecord;

  for (const field of [
    "status",
    "account_status",
    "employment_status",
    "role_status",
  ]) {

    if (excludedStatuses.has(normalized(record[field]))) {
      return false;
    }

  }

  for (const field of ["active", "is_active"]) {

    if (normalized(record[field]) === "false") {
      return false;
    }

  }

  for (const field of ["archived", "is_archived"]) {

    if (normalized(record[field]) === "true") {
      return false;
    }

  }

  for (const field of ["archived_at", "deleted_at"]) {

    if (
      record[field] !== null &&
      record[field] !== undefined &&
      normalized(record[field]) !== ""
    ) {
      return false;
    }

  }

  return true;

}

export function operationalOptions<T>(
  records: readonly T[],
): T[] {

  return records.filter(
    record => isOperationallyEnabled(record)
  );

}

export function operationalSelectionAllowed(
  records: readonly OperationalRecord[],
  selectedId: string,
): boolean {

  if (!selectedId.trim()) return false;

  return records.some(
    record =>
      record["id"] === selectedId &&
      isOperationallyEnabled(record),
  );

}

export function assertOperationalSelection(
  records: readonly OperationalRecord[],
  selectedId: string,
): void {

  if (!operationalSelectionAllowed(records, selectedId)) {

    throw new Error(
      "The selected record is unavailable or inactive. Refresh your selection."
    );

  }

}
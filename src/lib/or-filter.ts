/**
 * PostgREST `or()` filter strings are comma/parenthesis delimited, so any free
 * text typed by an operator must be sanitised before it is spliced into one.
 * Without this, a search value containing `,` or `(` changes which filter
 * conditions actually run instead of being matched literally.
 */
export function sanitizeFilterText(value: string): string {
  return value.trim().replace(/[,()*]/g, " ").trim();
}

/** Builds a safe `col.ilike.%term%,...` clause list for `.or()`. */
export function ilikeOrFilter(columns: readonly string[], value: string): string {
  const safe = sanitizeFilterText(value);
  return columns.map((col) => `${col}.ilike.%${safe}%`).join(",");
}

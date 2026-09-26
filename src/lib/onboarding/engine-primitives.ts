/**
 * NEØ Intelligent Data Onboarding — value primitives.
 *
 * Extracted from the engine so that matching, semantic profiling and duplicate
 * detection can share exactly the same reading of a cell without importing one
 * another. Pure functions only: they read values, they never invent them.
 */

/** Strips the noise legacy spreadsheets carry, without altering meaning. */
export function cleanCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").trim().replace(/\s{2,}/g, " ");
}

export function normaliseHeader(header: string): string {
  return cleanCell(header)
    .toLowerCase()
    .replace(/[_\-/\\]+/g, " ")
    .replace(/[^a-z0-9& ]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normaliseHeader(value).split(" ").filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** 0..1 similarity between two free-text labels. */
export function similarity(a: string, b: string): number {
  const x = normaliseHeader(a);
  const y = normaliseHeader(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = tokens(x);
  const tb = tokens(y);
  const overlap = ta.filter((t) => tb.includes(t)).length;
  const tokenScore = overlap === 0 ? 0 : (2 * overlap) / (ta.length + tb.length);
  const distance = levenshtein(x, y);
  const editScore = 1 - distance / Math.max(x.length, y.length);
  const containment = x.includes(y) || y.includes(x) ? 0.82 : 0;
  return Math.max(tokenScore, editScore, containment);
}

export function parseDateValue(value: string): string | null {
  const raw = cleanCell(value);
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
  const serial = Number(raw);
  if (!Number.isNaN(serial) && serial > 20000 && serial < 60000 && /^\d+$/.test(raw)) {
    // Spreadsheet serial date (days since 1899-12-30).
    const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const parts = raw.split(/[/.\-\s]+/).filter(Boolean);
  if (parts.length >= 3) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const monthWord = months.indexOf(parts[1]!.slice(0, 3).toLowerCase());
    let d = Number(parts[0]);
    let m = monthWord >= 0 ? monthWord + 1 : Number(parts[1]);
    const y = Number(parts[2]!.length === 2 ? `20${parts[2]}` : parts[2]);
    if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(y)) return null;
    // Only month/day/year when day/month/year is impossible — never a guess
    // that silently changes a valid date.
    if (m > 12 && d <= 12) [d, m] = [m, d];
    if (m > 12 || d > 31 || y < 1900 || y > 2200) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

export function parseNumberValue(value: string): number | null {
  const raw = cleanCell(value).replace(/[^\d.,\-]/g, "");
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

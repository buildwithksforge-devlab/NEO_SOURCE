/**
 * Workbook reading for the onboarding engine.
 *
 * Handles what real hotels actually send: CSV, TSV and multi-sheet Excel, with
 * blank leading rows, merged title banners and trailing empty columns. It only
 * reads — it never repairs a value.
 */
import { cleanCell, type SheetTable } from "./engine";

function tabulate(sheet: string, matrix: unknown[][]): SheetTable | null {
  // Legacy exports often start with a title banner. The header row is the
  // first row with at least two non-empty cells that are not all numbers.
  let headerIndex = -1;
  for (let i = 0; i < Math.min(matrix.length, 25); i++) {
    const cells = (matrix[i] ?? []).map(cleanCell);
    const filled = cells.filter(Boolean);
    if (filled.length >= 2 && filled.some((c) => /[a-z]/i.test(c))) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return null;

  const rawHeaders = (matrix[headerIndex] ?? []).map(cleanCell);
  const headers: string[] = [];
  rawHeaders.forEach((header, index) => {
    const base = header || `column_${index + 1}`;
    let name = base;
    let suffix = 2;
    while (headers.includes(name)) name = `${base} (${suffix++})`;
    headers.push(name);
  });

  const rows: Record<string, string>[] = [];
  for (let i = headerIndex + 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? [];
    const row: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((header, index) => {
      const value = cleanCell(cells[index]);
      row[header] = value;
      if (value) hasValue = true;
    });
    if (hasValue) rows.push(row);
  }

  const usedHeaders = headers.filter((h) => rows.some((r) => r[h]));
  return { sheet, headers: usedHeaders.length ? usedHeaders : headers, rows };
}

/** Reads every sheet in the file. The caller chooses which one to import. */
export async function readWorkbook(file: File): Promise<SheetTable[]> {
  // The spreadsheet engine is large and only ever needed once an
  // administrator actually opens a file, so it is fetched on demand.
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const isText = /\.(csv|tsv|txt)$/i.test(file.name);
  const workbook = isText
    ? XLSX.read(new TextDecoder().decode(buffer), { type: "string", raw: true })
    : XLSX.read(buffer, { type: "array", cellDates: true });

  const tables: SheetTable[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "", raw: false });
    const table = tabulate(name, matrix as unknown[][]);
    if (table && table.rows.length) tables.push(table);
  }
  return tables;
}

/** Offers a template or example file as a download, without leaving the page. */
export function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

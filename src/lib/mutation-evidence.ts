/** Require the existing server's saved-record evidence before showing success. */
export function savedRecord(value: unknown, key = 'id', expected?: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('The server did not confirm a saved record. Refresh before trying again.');
  const row = value as Record<string, unknown>;
  if (row['ok'] === false) throw Error(String(row['detail'] || row['reason'] || 'The action was not completed.'));
  const id = row[key];
  if (typeof id !== 'string' || !id.trim() || ['null','undefined'].includes(id) || (expected !== undefined && id !== expected)) {
    throw Error('The server did not confirm the expected saved record. Refresh before trying again.');
  }
  return row;
}

export function savedQuotation(value: unknown, quotationId: string, lineCount: number) {
  const row = savedRecord(value, 'quotation_id', quotationId);
  if (row['line_count'] !== lineCount || typeof row['grand_total'] !== 'number' || !Number.isFinite(row['grand_total']) || row['grand_total'] < 0) {
    throw Error('The server did not confirm all quotation lines and their total. Refresh the quotation before retrying.');
  }
  return row;
}

export function savedGuestBooking(value: unknown) {
  const row = savedRecord(value);
  if (row['ok'] !== true || typeof row['confirmation_number'] !== 'string' || !row['confirmation_number'].trim()
    || typeof row['total_amount'] !== 'number' || !Number.isFinite(row['total_amount']) || row['total_amount'] < 0) {
    throw Error('The hotel did not confirm this booking. Refresh your trips before trying again.');
  }
  return row as {ok:true;idempotent:boolean;id:string;confirmation_number:string;total_amount:number};
}

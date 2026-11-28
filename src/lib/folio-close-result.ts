/** A transport success is not evidence that the folio was closed. */
export function requireFolioCloseResult(value: unknown, folio: string): unknown {
  if (!value || typeof value !== 'object') throw new Error('The folio close result could not be verified. Refresh before retrying.');
  const result = value as Record<string, unknown>;
  if (result['ok'] !== true) {
    if (result['reason'] === 'balance_outstanding') throw new Error('This folio still has an outstanding balance and was not closed.');
    if (result['reason'] === 'pending_payments') throw new Error('Payments are awaiting confirmation. This folio was not closed.');
    throw new Error('The folio was not closed. Refresh its details before retrying.');
  }
  if (result['folio_id'] !== folio || (result['reason'] !== 'already_closed' && (result['status'] !== 'closed' || Number(result['balance']) !== 0 || result['balance'] == null))) {
    throw new Error('The folio close result could not be verified. Refresh before retrying.');
  }
  return value;
}

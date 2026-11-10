export function parseOutboxReplayBatch(value: unknown) {
 if (!value || typeof value !== 'object') throw new Error('The handoff replay result could not be verified. Refresh before retrying.');
 const row=value as Record<string,unknown>;
 if(row['ok'] !== true) throw new Error(typeof row['detail'] === 'string' ? row['detail'] : 'The handoffs were not requeued.');
 const count=(key:string)=>{const v=row[key];if(typeof v !== 'number' || !Number.isSafeInteger(v) || v<0)throw new Error('The handoff replay counts could not be verified. Refresh before retrying.');return v;};
 return {requeued:count('requeued'),alreadyProcessed:count('already_processed'),failed:count('failed')};
}

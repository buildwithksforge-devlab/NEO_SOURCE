-- Read-only. Exports routine definitions and grants for comparison with source.
-- No provider connections, credentials, payment records or callback payloads are read.
WITH routines(operation, signature) AS (
  VALUES
    ('open', 'public.neo_payment_intent_open(text,uuid,text,numeric,uuid,text,text,text,uuid)'),
    ('mark_sent', 'public.neo_payment_intent_mark_sent(uuid,text,text,boolean)'),
    ('claim', 'public.neo_payment_intent_claim_dispatch(uuid,text)'),
    ('apply', 'public.neo_payment_intent_apply(text,text,text,text,jsonb)')
), resolved AS (
  SELECT *, to_regprocedure(signature) AS routine FROM routines
)
SELECT operation,
       signature,
       md5(pg_get_functiondef(routine)) AS definition_digest,
       pg_get_functiondef(routine) AS definition,
       p.proacl::text AS explicit_grants
FROM resolved
LEFT JOIN pg_proc p ON p.oid = routine
ORDER BY operation;

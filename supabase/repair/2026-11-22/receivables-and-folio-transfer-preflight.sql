-- Read-only. Capture candidate baselines before applying the two finance migrations.
WITH expected(signature, baseline, installed_lf, installed_crlf) AS (
  VALUES
    ('public.neo_ar_record_customer_payment(uuid,numeric,text,text,date,text,uuid,text,uuid)',
     'eafa41a8305e6f621675f9ab66ea753e', '06b710c4fa6e97a0643da5db46506d10', 'ce4983e5f70316dcd9cdc185b88a5321'),
    ('public.folio_transfer_line(uuid,uuid,text)',
     'edfa202791098f169e5a2694d6714211', '223f0fe9c6f3e84c00b773f81250c525', 'c521335319e62a91ceaf1754490d64ee')
), routines AS (
  SELECT *, to_regprocedure(signature) AS routine FROM expected
), definitions AS (
  SELECT *, md5(pg_get_functiondef(routine)) AS definition,
         md5(replace(pg_get_functiondef(routine), chr(13) || chr(10), chr(10))) AS normalized_digest
  FROM routines
)
SELECT signature, definition,
       CASE WHEN routine IS NULL THEN 'missing'
            WHEN normalized_digest = installed_lf OR definition = installed_crlf THEN 'installed'
            WHEN baseline IN (definition, normalized_digest) THEN 'supported baseline'
            ELSE 'review required' END AS rollout_status,
       has_function_privilege('anon', routine, 'EXECUTE') AS anonymous_execute,
       has_function_privilege('authenticated', routine, 'EXECUTE') AS authenticated_execute
FROM definitions
ORDER BY signature;

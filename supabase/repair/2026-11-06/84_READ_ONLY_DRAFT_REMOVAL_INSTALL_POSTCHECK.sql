-- Code-installation evidence only. Does not remove or modify an order.
BEGIN TRANSACTION READ ONLY;
WITH expected(signature, fingerprint) AS (VALUES
 ('public.neo_pos_remove_draft(uuid,text)', 'e64d35e24c1c836e4f3af308102c82ee'),
 ('public.neo_pos_removed_draft_write_guard()', 'c44cb8d9f0684bac8acf3eb1fb8b3da5')
), definitions AS (
 SELECT signature, to_regprocedure(signature) IS NOT NULL
   AND md5(pg_get_functiondef(to_regprocedure(signature))) = fingerprint AS matches
 FROM expected
)
SELECT jsonb_build_object(
 'diagnostic_version','draft-removal-install-v1',
 'read_only',current_setting('transaction_read_only'),
 'code', (SELECT jsonb_agg(to_jsonb(d)) FROM definitions d),
 'definitions_match', (SELECT bool_and(matches) FROM definitions),
 'scope','Code installation only; no order removal or full workflow certification.'
) AS diagnostic;
COMMIT;

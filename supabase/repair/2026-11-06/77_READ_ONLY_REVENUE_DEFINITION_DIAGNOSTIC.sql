-- Read only: distinguish old code, newline differences and unexpected deployed code.
BEGIN READ ONLY;
WITH actual AS (
 SELECT pg_get_functiondef('public.neo_revenue_reconciliation(uuid,date,date)'::regprocedure) AS definition
)
SELECT jsonb_build_object(
 'diagnostic_version','revenue-definition-difference-v1',
 'read_only',current_setting('transaction_read_only'),
 'actual_md5',md5(definition),
 'expected_md5','18b839422b51de507a25fbea284f9417',
 'original_definition_still_installed',md5(definition)='851f91742ef2f87d5641def2d8eaacc3',
 'matches_after_cr_removal',md5(replace(definition,chr(13),''))='18b839422b51de507a25fbea284f9417',
 'definition',definition
) AS diagnostic FROM actual;
COMMIT;

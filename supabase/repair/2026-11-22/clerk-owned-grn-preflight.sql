-- Read-only. Run before and after applying the corrected receiving migration.
WITH expected(signature, baselines, installed_digest, expected_authenticated_execute) AS (
  VALUES
    ('public.neo_blind_receiving_decide(uuid,text,text)', ARRAY['764991c4b5bb786410e0e08776d78c06','e2be8f7d872d0aaca87606a576ea0c09'], '1caba518c36793706d2cce33f201995e', true),
    ('public.neo_post_approved_blind_receiving(uuid)', ARRAY['27154efb39e351bbdeba6b4301b512fc','fc3ae6e7d18c322f114a331fee1e99da'], 'e5dae5fbeefe865533a5309c3d2f5ba3', true),
    ('public.neo_blind_receiving_approved_queue()', ARRAY['1afc41c5957e70ab02db12c694137d2b','e1e76d7aa6ced7790192bf5c15a050d4'], '87a68de16d8c6ec616aad60d07d1f59f', true),
    ('public.neo_blind_receiving_review_queue()', ARRAY['144238f2a1fb98d421834ef66594dafe','bd8ba9da435ba30e909fd0eb39f5cefa'], '778ce55b8d107ee93666dc12a8a6a549', true),
    ('public.neo_receiving_post_receipt_internal(uuid)', ARRAY['88942e02590968c978ca9e28ce98c2ab','59ffb83f0d54333aa0bbbdfc62b486cc','daaf3e2e497dbc1b06ec5c69c64f7f70','b194cc9d490c90c4b042c7090fe0bf03'], '8e517246600878edf6b2e93114153283', false)
), routines AS (
  SELECT e.*, p.oid, p.prosecdef,
         md5(replace(p.prosrc, chr(13)||chr(10), chr(10))) AS definition_digest
  FROM expected e LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.signature)
), status AS (
  SELECT *,
         CASE WHEN oid IS NULL THEN 'missing'
              WHEN prosecdef IS NOT TRUE THEN 'review required'
              WHEN definition_digest = installed_digest THEN 'installed'
              WHEN definition_digest = ANY(baselines) THEN 'supported baseline'
              ELSE 'review required' END AS rollout_status,
         has_function_privilege('authenticated', oid, 'EXECUTE') AS authenticated_execute,
         has_function_privilege('anon', oid, 'EXECUTE') AS anonymous_execute,
         has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_execute
  FROM routines
)
SELECT signature, definition_digest, rollout_status,
       authenticated_execute, anonymous_execute, service_role_execute,
       (authenticated_execute IS NOT DISTINCT FROM expected_authenticated_execute
         AND anonymous_execute IS FALSE
         AND (expected_authenticated_execute OR service_role_execute IS FALSE)) AS permissions_match
FROM status
ORDER BY signature;

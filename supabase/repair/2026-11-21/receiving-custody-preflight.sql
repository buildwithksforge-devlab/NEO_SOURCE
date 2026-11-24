-- Read-only. Run before installing receiving custody on request.
WITH expected(signature, marker) AS (
    VALUES
        ('public.neo_receiving_custody_queue()', 'neo_receiving_custody x'),
        ('public.neo_accept_receiving_custody(uuid,jsonb)', 'prior_review'),
        ('public.neo_blind_receiving_decide(uuid,text,text)', 'Approval requires matching custody'),
        ('public.neo_post_approved_blind_receiving(uuid)', 'Posting requires independent Storekeeper custody'),
        ('public.neo_blind_receiving_approved_queue()', 'neo_receiving_custody x'),
        ('public.neo_blind_receiving_review_queue()', 'own-custody')
)
SELECT e.signature,
       p.oid IS NOT NULL AS installed,
       COALESCE(p.prosecdef AND strpos(p.prosrc, e.marker) > 0
           AND strpos(p.prosrc, 'neo_receiving_recounts') = 0, false) AS matches_custody_baseline,
       md5(pg_get_functiondef(p.oid)) AS definition_digest,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_callable,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anonymous_callable,
       to_regprocedure('public.neo_request_receiving_recount(uuid,text)') IS NOT NULL AS recount_installed
FROM expected e
LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.signature)
ORDER BY e.signature;

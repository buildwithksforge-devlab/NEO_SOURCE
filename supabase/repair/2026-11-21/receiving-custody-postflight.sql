-- Read-only. Confirm installation and the expected permission boundary.
SELECT
  to_regclass('public.neo_receiving_recounts') IS NOT NULL AS recount_table_exists,
  to_regprocedure('public.neo_request_receiving_recount(uuid,text)') IS NOT NULL AS recount_rpc_installed,
  has_function_privilege('authenticated', to_regprocedure('public.neo_request_receiving_recount(uuid,text)'), 'EXECUTE') AS authenticated_can_request,
  has_function_privilege('anon', to_regprocedure('public.neo_request_receiving_recount(uuid,text)'), 'EXECUTE') AS anonymous_can_request,
  coalesce((SELECT strpos(prosrc, '''recount_requested''') > 0 FROM pg_proc
    WHERE oid = to_regprocedure('public.neo_blind_receiving_review_queue()')), false) AS review_queue_reports_recount;

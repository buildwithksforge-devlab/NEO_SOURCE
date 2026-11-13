-- Read-only installation check for the 12 November M-Pesa dispatch repair.
-- Returns no credentials, callback tokens, customer details or payment rows.
SELECT
  to_regprocedure('public.neo_mpesa_collection_start(text,uuid,text,numeric,text,uuid)') IS NOT NULL AS collection_start_installed,
  to_regprocedure('public.neo_mpesa_guest_deposit_start(uuid,text,text,numeric)') IS NOT NULL AS deposit_start_installed,
  to_regprocedure('public.neo_mpesa_claim_dispatch(uuid,uuid)') IS NOT NULL AS dispatch_claim_installed,
  EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'mpesa_transactions'
      AND column_name = 'dispatch_claimed_at') AS claim_column_installed,
  coalesce(has_function_privilege('authenticated',
    to_regprocedure('public.neo_mpesa_collection_start(text,uuid,text,numeric,text,uuid)'), 'EXECUTE'), false) AS staff_and_guest_start_allowed,
  to_regprocedure('public.neo_mpesa_claim_dispatch(uuid,uuid)') IS NOT NULL
    AND NOT coalesce(has_function_privilege('anon',
      to_regprocedure('public.neo_mpesa_claim_dispatch(uuid,uuid)'), 'EXECUTE'), false)
    AND NOT coalesce(has_function_privilege('authenticated',
      to_regprocedure('public.neo_mpesa_claim_dispatch(uuid,uuid)'), 'EXECUTE'), false)
    AND coalesce(has_function_privilege('service_role',
      to_regprocedure('public.neo_mpesa_claim_dispatch(uuid,uuid)'), 'EXECUTE'), false) AS dispatch_claim_server_only;

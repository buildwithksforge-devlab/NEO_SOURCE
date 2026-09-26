DO $$
DECLARE r record; names text[] := ARRAY[
 'cash_close_shift','cash_open_shift','cash_shift_expected','cash_record_movement','cash_review_shift',
 'corp_account_aging','corp_credit_check',
 'folio_post_charge','folio_reopen','folio_reverse_line','folio_transfer_line',
 'neo_close_business_day','neo_night_audit_run','neo_my_approval_authority','neo_pending_collections',
 'neo_adopt_modern_model','neo_archive_legacy_role','neo_execute_role_migration','neo_model_adoption_status',
 'neo_plan_role_migration','neo_role_migration_preflight','neo_role_reconciliation',
 'pms_group_convert_rooming','pms_group_record_deposit','pms_group_release_block',
 'pms_waitlist_convert','pms_waitlist_close','pms_waitlist_offer',
 'pms_request_assign','pms_request_complete','pms_request_feedback'];
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace AND p.proname = ANY(names)
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
  END LOOP;
END $$;
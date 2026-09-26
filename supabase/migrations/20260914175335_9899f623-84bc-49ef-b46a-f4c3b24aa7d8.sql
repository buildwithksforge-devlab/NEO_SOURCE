DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, pg_get_function_result(p.oid) = 'trigger' AS is_trigger
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('hk_block_duplicate_open_job','hk_reconcile_stale_jobs','hk_resolve_stale_job','hk_stale_job_candidates','my_rider_branch_id','neo_delivery_order_ensure_pin','neo_event_chain_status','neo_event_close_out','neo_folio_settlement_syncs_reservation','neo_menu_catalogue','neo_po_followup_task_sync','neo_purchase_request_recalc_total','neo_reservation_sync_financial_state','neo_station_store_gaps','neo_station_store_readiness','neo_stores_adjustment_decide','neo_stores_count_reconcile')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    IF NOT r.is_trigger THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
  END LOOP;
END $$;
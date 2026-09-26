DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'neo_grounds_task_advance','neo_grounds_task_assign','neo_grounds_task_create',
         'neo_grounds_task_guard','neo_landscaping_generate_due','neo_landscaping_schedule_save',
         'neo_maint_job_advance','neo_maint_record_parts','neo_maint_touch_updated_at'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'neo_grounds_task_advance','neo_grounds_task_assign','neo_grounds_task_create',
         'neo_landscaping_generate_due','neo_landscaping_schedule_save',
         'neo_maint_job_advance','neo_maint_record_parts'
       )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
  END LOOP;
END $$;

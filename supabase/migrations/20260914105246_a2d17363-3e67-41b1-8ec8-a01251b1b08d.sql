DO $mig$
DECLARE def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_event_billing_record_payment';
  IF def IS NULL THEN
    RAISE EXCEPTION 'neo_event_billing_record_payment is missing';
  END IF;
  IF position($tok$PERFORM public.fin_post_journal(v_journal);$tok$ in def) = 0 THEN
    RAISE EXCEPTION 'expected posting call not found';
  END IF;
  def := replace(
    def,
    $tok$      PERFORM public.fin_post_journal(v_journal);$tok$,
    $tok$      -- The journal is raised by the routine itself, not hand-written by the
      -- user, so it posts as a system posting for this statement only.
      PERFORM set_config('neo.system_posting', 'on', true);
      PERFORM public.fin_post_journal(v_journal);
      PERFORM set_config('neo.system_posting', 'off', true);$tok$);
  EXECUTE def;
END
$mig$;
DO $mig$
DECLARE def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_event_billing_record_payment';
  IF def IS NULL THEN
    RAISE EXCEPTION 'neo_event_billing_record_payment is missing';
  END IF;
  IF position($tok$'receipt', CURRENT_DATE$tok$ in def) = 0 THEN
    RETURN;
  END IF;
  def := replace(def, $tok$'receipt', CURRENT_DATE$tok$, $tok$'automatic', CURRENT_DATE$tok$);
  EXECUTE def;
END
$mig$;
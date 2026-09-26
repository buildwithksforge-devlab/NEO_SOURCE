DO $do$
DECLARE
  _fn text;
  _src text;
  _new text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY['neo_guest_order_tracking','neo_guest_order_cancel'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO _src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _fn;

    IF _src IS NULL OR position('public.kitchen_tickets' in _src) = 0 THEN
      RAISE EXCEPTION 'Expected obsolete kitchen_tickets reference in %', _fn;
    END IF;

    _new := replace(_src, 'public.kitchen_tickets', 'public.station_tickets');
    EXECUTE _new;
  END LOOP;
END
$do$;
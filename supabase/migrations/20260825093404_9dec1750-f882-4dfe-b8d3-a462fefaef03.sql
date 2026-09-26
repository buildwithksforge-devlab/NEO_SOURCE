DO $$
DECLARE _def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_provision_worker';

  _def := replace(
    _def,
    E'_staff_ref := COALESCE(NULLIF(trim(_payload->>''staff_id''), ''''),\n                         ''STF-'' || upper(substr(replace(_uid::text,''-'',''''), 1, 6)));',
    E'_staff_ref := COALESCE(NULLIF(trim(_payload->>''staff_id''), ''''),\n                         public.neo_allocate_staff_id(_org));'
  );

  IF _def NOT LIKE '%neo_allocate_staff_id(_org)%' THEN
    RAISE EXCEPTION 'staff identifier fallback not found in neo_provision_worker';
  END IF;

  EXECUTE _def;
END $$;
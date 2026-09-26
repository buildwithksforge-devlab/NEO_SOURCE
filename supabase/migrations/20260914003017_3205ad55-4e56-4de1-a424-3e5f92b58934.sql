DO $do$
DECLARE src text; needle text; repl text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_event_beo_publish';
  IF src IS NULL THEN RAISE EXCEPTION 'neo_event_beo_publish missing'; END IF;

  needle := $q$'Guests: ' || coalesce(o.guaranteed_guests,0) || '. Setup from ' || to_char(o.setup_at, 'DD Mon HH24:MI') || '.'$q$;
  repl := $q$'Guests: ' || coalesce(o.guaranteed_guests,0) || '. Setup from ' || coalesce(to_char(o.setup_at, 'DD Mon HH24:MI'), 'a time not yet set') || '.'$q$;

  IF position(needle in src) = 0 THEN
    RAISE EXCEPTION 'setup_at concatenation not found in neo_event_beo_publish';
  END IF;

  EXECUTE replace(src, needle, repl);
END $do$;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated;', r.proname, r.args);
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_provider_settings','etims_settings','mpesa_settings','provider_credentials']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated;', t);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role;', t);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
      EXECUTE format($f$
        CREATE POLICY %I ON public.%I
        AS RESTRICTIVE FOR ALL
        TO anon, authenticated
        USING (false) WITH CHECK (false);
      $f$, t || '_server_only_denied', t);
    END IF;
  END LOOP;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
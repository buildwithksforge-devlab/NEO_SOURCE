REVOKE EXECUTE ON FUNCTION public.neo_hr_payroll_compute(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_hr_payroll_post(uuid) FROM anon;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'trg_neo_structure_guard' AND c.relname = 'profiles'
  ) THEN
    CREATE TRIGGER trg_neo_structure_guard
      BEFORE INSERT OR UPDATE ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.neo_structure_guard();
  END IF;
END $$;
-- Extend the scoped test-purge escape hatch to the remaining delete guards.
CREATE OR REPLACE FUNCTION public.neo_test_purge_active(_row jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT coalesce(current_setting('neo.test_purge', true), '') <> ''
     AND (
       (_row ? 'organization_id') IS NOT TRUE
       OR _row->>'organization_id' IS NULL
       OR _row->>'organization_id' = current_setting('neo.test_purge', true)
     );
$$;

CREATE OR REPLACE FUNCTION public.proc_block_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF public.neo_test_purge_active(to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Transactional records cannot be deleted. Use cancellation, void, reversal, return or a credit note instead.';
END $function$;

CREATE OR REPLACE FUNCTION public.fin_protect_posted_journal_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE s text;
BEGIN
  IF TG_OP = 'DELETE' AND public.neo_test_purge_active(to_jsonb(OLD)) THEN RETURN OLD; END IF;
  SELECT status INTO s FROM public.journal_entries WHERE id = COALESCE(NEW.journal_id, OLD.journal_id);
  IF s IN ('posted','reversed') THEN RAISE EXCEPTION 'Lines of a posted journal cannot change'; END IF;
  RETURN COALESCE(NEW, OLD);
END $function$;

CREATE OR REPLACE FUNCTION public.fin_protect_used_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF public.neo_test_purge_active(to_jsonb(OLD)) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'Account has financial activity and cannot be deleted; deactivate it instead';
  END IF;
  RETURN OLD;
END $function$;

REVOKE ALL ON FUNCTION public.neo_test_purge_active(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_test_purge_active(jsonb) TO service_role;
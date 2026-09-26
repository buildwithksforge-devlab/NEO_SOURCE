
CREATE OR REPLACE FUNCTION public.neo_normalise_phone(_p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT NULLIF(right(regexp_replace(coalesce(_p,''), '[^0-9]', '', 'g'), 9), '')
$$;

REVOKE ALL ON FUNCTION public.neo_normalise_phone(text) FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_scan_person_duplicates(text) FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_review_person_duplicate(uuid,text,text) FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_merge_person_duplicate(uuid,uuid,text) FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_print_enqueue(uuid,text,text,jsonb,text) FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_print_record_result(uuid,boolean,text) FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_print_retry(uuid) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.neo_normalise_phone(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_scan_person_duplicates(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_review_person_duplicate(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_merge_person_duplicate(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_print_enqueue(uuid,text,text,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_print_record_result(uuid,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_print_retry(uuid) TO authenticated;

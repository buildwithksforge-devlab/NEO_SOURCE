CREATE OR REPLACE FUNCTION public.neo_backfill_reporting_lines(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  meta record;
  n_candidates integer;
  only_manager uuid;
  linked integer := 0;
  review integer := 0;
  missing integer := 0;
  skipped integer := 0;
  details jsonb := '[]'::jsonb;
BEGIN
  FOR rec IN
    SELECT p.id, p.full_name, p.branch_id, p.reporting_manager_id,
           COALESCE(array_agg(ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS role_ids
      FROM public.profiles p
      LEFT JOIN public.user_roles ur ON ur.user_id = p.id
     WHERE p.organization_id = _org
       AND p.account_type = 'staff'
       AND p.account_status = 'active'
     GROUP BY p.id
  LOOP
    IF rec.reporting_manager_id IS NOT NULL THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    SELECT * INTO meta FROM public.neo_role_reporting_meta(rec.role_ids);
    IF NOT meta.manager_required
       OR meta.allowed_manager_keys IS NULL
       OR array_length(meta.allowed_manager_keys, 1) IS NULL THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    SELECT count(*), (array_agg(c.profile_id))[1]
      INTO n_candidates, only_manager
      FROM public.neo_reporting_candidate_rows(_org, rec.id, rec.branch_id, rec.role_ids) c;

    IF n_candidates = 1 THEN
      UPDATE public.profiles
         SET reporting_manager_id = only_manager,
             reporting_effective_from = COALESCE(reporting_effective_from, CURRENT_DATE),
             assignment_review_required = false,
             assignment_review_reason = ''
       WHERE id = rec.id;
      linked := linked + 1;
    ELSIF n_candidates > 1 THEN
      UPDATE public.profiles
         SET assignment_review_required = true,
             assignment_review_reason = format(
               '%s eligible managers — confirm the reporting line.', n_candidates)
       WHERE id = rec.id;
      review := review + 1;
    ELSE
      UPDATE public.profiles
         SET assignment_review_required = true,
             assignment_review_reason = format(
               'No active holder of the required manager role (%s).',
               array_to_string(meta.allowed_manager_keys, ', '))
       WHERE id = rec.id;
      missing := missing + 1;
      details := details || jsonb_build_object(
        'profile', rec.id, 'name', rec.full_name,
        'missing_roles', to_jsonb(meta.allowed_manager_keys));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('organization', _org, 'linked', linked,
    'review_required', review, 'missing_manager_role', missing,
    'left_as_is', skipped, 'missing_details', details);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_backfill_reporting_lines(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_backfill_reporting_lines(uuid) TO service_role;
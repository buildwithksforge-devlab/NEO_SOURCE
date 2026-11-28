-- Install through the generated migration, after reviewed minibar scope guards.
CREATE OR REPLACE FUNCTION public.neo_minibar_post_once(
  _folio uuid,_location uuid,_lines jsonb,_room uuid,_notes text,_attempt uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE
  org uuid:=public.current_org_id();
  folio_record public.folios;
  stay_record public.stays;
  prior public.minibar_posting_attempts;
  request jsonb:=jsonb_build_object('folio',_folio,'location',_location,'lines',_lines,'room',_room,'notes',_notes);
  response jsonb;
  previous_attempt text;
  previous_posting text;
BEGIN
  IF auth.uid() IS NULL OR org IS NULL OR public.has_permission('front-office','folios','create') IS NOT TRUE THEN
    RAISE EXCEPTION 'Not permitted to post minibar consumption' USING ERRCODE='42501';
  END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'A durable minibar attempt key is required'; END IF;
  SELECT * INTO folio_record FROM public.folios WHERE id=_folio AND organization_id=org FOR UPDATE;
  IF folio_record.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(folio_record.branch_id),false) THEN
    RAISE EXCEPTION 'Minibar folio is outside your property scope' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':minibar-attempt:'||_attempt::text,0));
  SELECT * INTO prior FROM public.minibar_posting_attempts WHERE organization_id=org AND attempt_id=_attempt;
  IF prior.attempt_id IS NOT NULL THEN
    IF prior.request IS DISTINCT FROM request THEN
      RAISE EXCEPTION 'Minibar attempt belongs to different work. Review saved posting % before starting a separate charge',prior.result->>'posting_number';
    END IF;
    IF prior.result IS NULL OR prior.result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Minibar attempt needs reconciliation'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.minibar_postings p WHERE p.id=(prior.result->>'posting_id')::uuid
      AND p.organization_id=org AND p.folio_id=_folio AND p.location_id=_location AND p.room_id=prior.room_id
      AND p.posting_number=prior.result->>'posting_number' AND p.total_amount=(prior.result->>'total')::numeric)
      OR (SELECT count(*) FROM public.minibar_posting_lines l WHERE l.posting_id=(prior.result->>'posting_id')::uuid
        AND l.organization_id=org) IS DISTINCT FROM (prior.result->>'lines')::bigint THEN
      RAISE EXCEPTION 'Saved minibar posting evidence is missing; reconcile before retrying';
    END IF;
    RETURN prior.result||jsonb_build_object('replayed',true);
  END IF;
  IF folio_record.status IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'Minibar folio is not open'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Minibar items are required'; END IF;
  IF jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 OR length(coalesce(_notes,''))>2000 THEN RAISE EXCEPTION 'Minibar draft is too large or empty'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_locations s WHERE s.id=_location AND s.organization_id=org
    AND s.branch_id=folio_record.branch_id AND s.active IS TRUE AND s.location_type='minibar') THEN
    RAISE EXCEPTION 'Choose an active store explicitly configured as Minibar for this property';
  END IF;
  SELECT * INTO stay_record FROM public.stays WHERE id=folio_record.stay_id AND organization_id=org FOR UPDATE;
  IF stay_record.id IS NULL OR stay_record.branch_id IS DISTINCT FROM folio_record.branch_id
    OR coalesce(stay_record.status,'') NOT IN ('checked-in','checked_in','in-house','in_house')
    OR (folio_record.reservation_id IS NOT NULL AND stay_record.reservation_id IS DISTINCT FROM folio_record.reservation_id)
    OR stay_record.room_id IS NULL OR (_room IS NOT NULL AND _room IS DISTINCT FROM stay_record.room_id)
    OR NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=stay_record.room_id AND r.organization_id=org AND r.branch_id=folio_record.branch_id) THEN
    RAISE EXCEPTION 'Minibar room must match this folio current in-house stay';
  END IF;

  INSERT INTO public.minibar_posting_attempts(organization_id,attempt_id,submitted_by,folio_id,location_id,room_id,request)
    VALUES(org,_attempt,auth.uid(),_folio,_location,stay_record.room_id,request);
  previous_attempt:=coalesce(current_setting('neo.minibar_attempt',true),'');
  previous_posting:=coalesce(current_setting('neo.system_posting',true),'off');
  BEGIN
    PERFORM set_config('neo.minibar_attempt',_attempt::text,true);
    response:=public.neo_minibar_post(_folio,_location,_lines,stay_record.room_id,_notes);
    PERFORM set_config('neo.minibar_attempt',previous_attempt,true);
    PERFORM set_config('neo.system_posting',previous_posting,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('neo.minibar_attempt',previous_attempt,true);
    PERFORM set_config('neo.system_posting',previous_posting,true);
    RAISE;
  END;
  IF response->>'ok' IS DISTINCT FROM 'true' OR nullif(response->>'posting_id','') IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.minibar_postings p WHERE p.id=(response->>'posting_id')::uuid
      AND p.organization_id=org AND p.folio_id=_folio AND p.location_id=_location AND p.room_id=stay_record.room_id
      AND p.total_amount=(response->>'total')::numeric) THEN
    RAISE EXCEPTION 'Minibar command did not confirm its saved posting: %',response;
  END IF;
  response:=response||jsonb_build_object('attempt_id',_attempt,'folio_id',_folio,'location_id',_location,'room_id',stay_record.room_id,'replayed',false);
  UPDATE public.minibar_posting_attempts SET result=response WHERE organization_id=org AND attempt_id=_attempt;
  RETURN response;
END;
$function$;

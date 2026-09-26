
CREATE OR REPLACE FUNCTION public.neo_merge_person_duplicate(_candidate uuid, _survivor uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.person_duplicate_candidates; loser uuid; res jsonb;
BEGIN
  SELECT * INTO c FROM person_duplicate_candidates WHERE id = _candidate;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF c.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Candidate belongs to another workspace'; END IF;
  IF c.entity_type <> 'customer' THEN RAISE EXCEPTION 'Only guest/customer records can be merged here'; END IF;
  IF c.status <> 'confirmed' THEN RAISE EXCEPTION 'Candidate must be reviewed and confirmed before merging'; END IF;
  IF coalesce(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A merge reason is required'; END IF;
  IF _survivor NOT IN (c.primary_id, c.duplicate_id) THEN RAISE EXCEPTION 'Surviving record must be one of the matched records'; END IF;
  loser := CASE WHEN _survivor = c.primary_id THEN c.duplicate_id ELSE c.primary_id END;

  res := public.neo_customer_merge(_survivor, loser, _reason);

  UPDATE person_duplicate_candidates
     SET status='merged', merged_at=now(), reviewed_by=auth.uid(), reviewed_at=now(),
         evidence = evidence || jsonb_build_object('survivor', _survivor, 'merged', loser, 'merge_result', res)
   WHERE id = _candidate;

  RETURN jsonb_build_object('survivor', _survivor, 'merged', loser, 'merge_result', res);
END $$;

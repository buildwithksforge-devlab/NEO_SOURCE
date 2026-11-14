CREATE OR REPLACE FUNCTION public.neo_reservation_collection_source_refresh()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE row_data jsonb; res uuid; previous_res uuid;
BEGIN
 row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 res:=CASE WHEN TG_TABLE_NAME='reservations' THEN nullif(row_data->>'id','')::uuid ELSE nullif(row_data->>'reservation_id','')::uuid END;
 IF res IS NULL THEN SELECT f.reservation_id INTO res FROM public.folios f WHERE f.id=nullif(row_data->>'folio_id','')::uuid AND f.organization_id=(row_data->>'organization_id')::uuid; END IF;
 IF res IS NOT NULL THEN PERFORM public.neo_reservation_financial_state_sync(res); END IF;
 IF TG_OP='UPDATE' THEN
  previous_res:=nullif(to_jsonb(OLD)->>'reservation_id','')::uuid;
  IF previous_res IS NULL THEN SELECT f.reservation_id INTO previous_res FROM public.folios f WHERE f.id=nullif(to_jsonb(OLD)->>'folio_id','')::uuid AND f.organization_id=OLD.organization_id; END IF;
  IF previous_res IS NOT NULL AND previous_res IS DISTINCT FROM res THEN PERFORM public.neo_reservation_financial_state_sync(previous_res); END IF;
 END IF;
 RETURN NULL;
END $function$

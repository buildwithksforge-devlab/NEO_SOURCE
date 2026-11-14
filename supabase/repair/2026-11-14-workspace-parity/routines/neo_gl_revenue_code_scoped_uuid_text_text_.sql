CREATE OR REPLACE FUNCTION public.neo_gl_revenue_code_scoped(_org uuid, _category text, _revenue_centre text DEFAULT NULL::text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path TO 'public'
AS $function$
DECLARE
 cat text:=replace(replace(lower(btrim(coalesce(_category,'other'))),'-','_'),' ','_');
 centre text:=replace(replace(lower(btrim(coalesce(_revenue_centre,''))),'-','_'),' ','_');
 stream text; labels text[]; codes text[];
BEGIN
 IF _org IS NULL THEN RAISE EXCEPTION 'Organization required for revenue classification'; END IF;
 stream:=CASE
  WHEN cat IN ('accommodation','room','rooms','lodging') THEN 'rooms'
  WHEN cat IN ('food_beverage','fnb','f_b') AND centre IN ('bar','main_bar','beverage') THEN 'bar'
  WHEN cat IN ('food_beverage','fnb','f_b') AND centre IN ('coffee','coffee_station','cafe') THEN 'coffee'
  WHEN cat IN ('room_service','in_room_dining') THEN 'room_service'
  WHEN cat IN ('meal_plan','restaurant','food','food_beverage','fnb','f_b','dining','kitchen',
   'dine_in','takeaway','take_away','takeout','counter','quick_service','pickup','walk_in',
   'buffet','banquet_food','cafe') THEN 'restaurant'
  WHEN cat IN ('bar','beverage','beverages','drinks','minibar','poolbar','pool_bar') THEN 'bar'
  WHEN cat IN ('coffee','espresso','barista') THEN 'coffee'
  WHEN cat IN ('laundry','dry_cleaning') THEN 'laundry'
  WHEN cat IN ('event','events','banquet','conference','event_catering') THEN 'events'
  WHEN cat='delivery' THEN 'delivery'
  WHEN cat IN ('transfer','transfers','airport_transfer') THEN 'transfers'
  WHEN cat='transport' THEN 'transport'
  WHEN cat IN ('other','miscellaneous','excursion') THEN 'other'
  ELSE NULL END;
 IF stream IS NULL THEN RAISE EXCEPTION 'Unmapped revenue category: %',_category USING ERRCODE='22023'; END IF;
 -- Existing org-level mappings take precedence. Property-specific mappings are
 -- not guessed by this signature, which intentionally has no property argument.
 SELECT array_agg(DISTINCT a.code) INTO codes FROM public.account_mappings m
 JOIN public.chart_of_accounts a ON a.id=m.credit_account_id AND a.organization_id=m.organization_id
 WHERE m.organization_id=_org AND m.active AND m.branch_id IS NULL AND m.payment_method IS NULL
  AND m.source_module IN (stream,cat)
  AND m.event_key IN ('revenue','earned','charge',stream||'.revenue',stream||'.earned')
  AND a.active AND a.postable AND NOT a.is_header AND a.category IN ('revenue','other_income');
 IF cardinality(codes)>1 THEN RAISE EXCEPTION 'Ambiguous revenue mappings for %; configure one account',stream; END IF;
 IF cardinality(codes)=1 THEN RETURN codes[1]; END IF;
 -- Resolve semantic account names from THIS workspace's chart. No hotel ID,
 -- copied account ID or workspace-specific account number is embedded here.
 labels:=CASE stream
  WHEN 'rooms' THEN ARRAY['room revenue','rooms revenue','accommodation revenue']
  WHEN 'restaurant' THEN ARRAY['restaurant revenue','food revenue','food and beverage revenue','food & beverage revenue']
  WHEN 'bar' THEN ARRAY['bar revenue','beverage revenue','bar and beverage revenue']
  WHEN 'coffee' THEN ARRAY['coffee revenue','cafe revenue','coffee station revenue']
  WHEN 'room_service' THEN ARRAY['room service revenue','in room dining revenue']
  WHEN 'laundry' THEN ARRAY['laundry revenue','guest laundry revenue']
  WHEN 'events' THEN ARRAY['event revenue','events revenue','banquet revenue','conference revenue']
  WHEN 'delivery' THEN ARRAY['delivery revenue']
  WHEN 'transfers' THEN ARRAY['transfer revenue','transfers revenue','airport transfer revenue']
  WHEN 'transport' THEN ARRAY['transport revenue']
  ELSE ARRAY['other revenue','other income','miscellaneous revenue'] END;
 SELECT array_agg(DISTINCT a.code) INTO codes FROM public.chart_of_accounts a
 WHERE a.organization_id=_org AND a.active AND a.postable AND NOT a.is_header
  AND a.category IN ('revenue','other_income')
  AND lower(btrim(replace(a.name,'-',' ')))=ANY(labels);
 IF cardinality(codes)>1 THEN RAISE EXCEPTION 'Ambiguous revenue accounts for %; configure an explicit mapping',stream; END IF;
 IF cardinality(codes)=1 THEN RETURN codes[1]; END IF;
 -- A property without separate room-service accounting uses its configured
 -- restaurant account, consistently in every workspace.
 IF stream='room_service' THEN RETURN public.neo_gl_revenue_code_scoped(_org,'restaurant',NULL); END IF;
 RAISE EXCEPTION 'Configure a revenue account or mapping for % in this workspace',stream USING ERRCODE='22023';
END $function$;
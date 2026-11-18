-- READ ONLY. Targeted follow-up: preserve newer payment code; compare staged
-- checkout/Minibar prerequisites; use the canonical station/store mapping.
SELECT jsonb_build_object(
 'payment_definition',(
   SELECT pg_get_functiondef(to_regprocedure('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)'))),
 'checkout_minibar_installation',(
   SELECT jsonb_agg(jsonb_build_object('signature',wanted.signature,
     'installed',p.oid IS NOT NULL,'owner',owner_role.rolname,
     'normalized_body_hash',md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))))
   FROM (VALUES ('public.pms_check_out(uuid,boolean,text)'),
     ('public.neo_folio_financial_components(uuid,uuid)'),
     ('public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'),
     ('public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)'),
     ('public.next_document_number(text,text,uuid,uuid)')) wanted(signature)
   LEFT JOIN pg_proc p ON p.oid=to_regprocedure(wanted.signature)
   LEFT JOIN pg_roles owner_role ON owner_role.oid=p.proowner
 ),
 'stock_consuming_stations_needing_review',coalesce((
   SELECT jsonb_agg(to_jsonb(review)) FROM (
     SELECT station.id,station.name,station.organization_id,station.branch_id,
       (SELECT count(*) FROM public.station_consumption_stores mapping
         JOIN public.stock_locations location ON location.id=mapping.location_id
         WHERE mapping.station_id=station.id AND mapping.organization_id=station.organization_id
           AND mapping.branch_id IS NOT DISTINCT FROM station.branch_id
           AND location.organization_id=station.organization_id AND location.active
           AND NOT coalesce(location.is_main,false)
           AND location.branch_id IS NOT DISTINCT FROM station.branch_id) AS valid_store_count
     FROM public.operational_stations station
     WHERE station.active AND (
       EXISTS(SELECT 1 FROM public.menu_items menu WHERE menu.station_id=station.id
         AND menu.organization_id=station.organization_id AND menu.consumption_mode IN ('direct_stock','recipe','batch'))
       OR EXISTS(SELECT 1 FROM public.recipes recipe WHERE recipe.station_id=station.id
         AND recipe.organization_id=station.organization_id AND recipe.status='active')
     )
   ) review WHERE review.valid_store_count<>1
 ),'[]'::jsonb)
) AS system_rollout_details;

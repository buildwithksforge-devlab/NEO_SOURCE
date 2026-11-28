-- Reuse only an existing, explicit station_id link, in the same organisation
-- and property. Never choose by store name or manufacture stock/store records.
BEGIN;
DO $repair$
DECLARE station record; location record; previous jsonb;
BEGIN
 FOR station IN SELECT s.* FROM public.operational_stations s WHERE s.active AND s.branch_id IS NOT NULL
   AND (EXISTS(SELECT 1 FROM public.menu_items m WHERE m.station_id=s.id AND m.organization_id=s.organization_id AND m.consumption_mode IN ('direct_stock','recipe','batch'))
     OR EXISTS(SELECT 1 FROM public.recipes r WHERE r.station_id=s.id AND r.organization_id=s.organization_id AND r.status='active'))
   ORDER BY s.organization_id,s.id FOR UPDATE LOOP
  -- A valid canonical mapping always takes precedence over the older field.
  IF EXISTS(SELECT 1 FROM public.station_consumption_stores map JOIN public.stock_locations l ON l.id=map.location_id
    WHERE map.station_id=station.id AND map.organization_id=station.organization_id
      AND map.branch_id=station.branch_id AND l.organization_id=station.organization_id
      AND l.branch_id=station.branch_id AND l.active AND NOT l.is_main) THEN CONTINUE; END IF;
  IF (SELECT count(*) FROM public.stock_locations l WHERE l.station_id=station.id
    AND l.organization_id=station.organization_id AND l.branch_id=station.branch_id
    AND l.active AND NOT l.is_main AND l.location_type<>'minibar')<>1 THEN CONTINUE; END IF;
  SELECT * INTO location FROM public.stock_locations l WHERE l.station_id=station.id
    AND l.organization_id=station.organization_id AND l.branch_id=station.branch_id
    AND l.active AND NOT l.is_main AND l.location_type<>'minibar' FOR UPDATE;
  SELECT to_jsonb(map) INTO previous FROM public.station_consumption_stores map WHERE map.station_id=station.id FOR UPDATE;
  INSERT INTO public.station_consumption_stores(organization_id,branch_id,station_id,location_id,created_by)
    VALUES(station.organization_id,station.branch_id,station.id,location.id,auth.uid())
    ON CONFLICT(station_id) DO UPDATE SET organization_id=EXCLUDED.organization_id,
      branch_id=EXCLUDED.branch_id,location_id=EXCLUDED.location_id,created_by=EXCLUDED.created_by;
  INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,previous_value,new_value,reason)
    VALUES(station.organization_id,station.branch_id,auth.uid(),'Lovable SQL repair ('||current_user||')',
      'repair.explicit_station_store_link','inventory',station.id::text,previous,
      jsonb_build_object('station_id',station.id,'location_id',location.id),
      'Reconciled the unique explicit existing station/store link into the canonical routing table; no store, balance or stock movement created.');
 END LOOP;
END $repair$;
COMMIT;
SELECT organization_id,branch_id,record_id,new_value FROM public.audit_logs
 WHERE action='repair.explicit_station_store_link' ORDER BY created_at DESC;

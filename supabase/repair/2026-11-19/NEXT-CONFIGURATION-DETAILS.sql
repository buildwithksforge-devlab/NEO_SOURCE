-- READ ONLY: existing physical stores and printer setup; no guessed mappings.
SELECT jsonb_build_object(
 'unmapped_consuming_stations',coalesce((
  SELECT jsonb_agg(to_jsonb(report)) FROM (
   SELECT station.id,station.name,station.organization_id,station.branch_id,station.department_id,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',location.id,'name',location.name,
      'type',location.location_type,'department_id',location.department_id,
      'legacy_station_id',location.station_id,'explicitly_linked_to_station',coalesce(location.station_id=station.id,false),
      'is_mini_store',location.is_mini_store))
      FROM public.stock_locations location
      WHERE location.organization_id=station.organization_id
        AND location.branch_id IS NOT DISTINCT FROM station.branch_id
        AND location.active AND NOT coalesce(location.is_main,false) AND location.location_type<>'minibar'),'[]'::jsonb) AS existing_property_stores
   FROM public.operational_stations station WHERE station.active
    AND (EXISTS(SELECT 1 FROM public.menu_items menu WHERE menu.station_id=station.id
      AND menu.organization_id=station.organization_id AND menu.consumption_mode IN ('direct_stock','recipe','batch'))
     OR EXISTS(SELECT 1 FROM public.recipes recipe WHERE recipe.station_id=station.id
      AND recipe.organization_id=station.organization_id AND recipe.status='active'))
    AND NOT EXISTS(SELECT 1 FROM public.station_consumption_stores mapping
      JOIN public.stock_locations location ON location.id=mapping.location_id
      WHERE mapping.station_id=station.id AND mapping.organization_id=station.organization_id
        AND mapping.branch_id IS NOT DISTINCT FROM station.branch_id
        AND location.organization_id=station.organization_id
        AND location.branch_id IS NOT DISTINCT FROM station.branch_id
        AND location.active AND NOT coalesce(location.is_main,false) AND location.location_type<>'minibar')
  ) report),'[]'::jsonb),
 'configured_printers',coalesce((
  SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'organization_id',organization_id,
    'branch_id',branch_id,'station_id',station_id,'role',printer_role,'connection_type',connection_type,
    'address',CASE WHEN address LIKE '%@%' THEN '[credential-bearing address omitted]' ELSE address END,
    'active',active,'health_status',health_status))
  FROM public.printer_profiles),'[]'::jsonb)
) AS configuration_details;

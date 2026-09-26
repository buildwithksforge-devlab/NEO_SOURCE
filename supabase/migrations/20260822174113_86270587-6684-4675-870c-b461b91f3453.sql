-- Menu import batch inspector: one scoped read model over import provenance.
CREATE OR REPLACE FUNCTION public.neo_menu_import_batches(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  batch_id uuid,
  file_name text,
  file_type text,
  reference text,
  status text,
  branch_id uuid,
  branch_name text,
  menu_id uuid,
  menu_name text,
  total_rows integer,
  imported_rows integer,
  committed_rows integer,
  rejected_rows integer,
  duplicate_rows integer,
  created_at timestamptz,
  created_by_name text,
  superseded boolean,
  superseded_by uuid,
  supersedes uuid,
  item_rows bigint,
  live_rows bigint,
  historical_rows bigint,
  published_rows bigint,
  draft_rows bigint,
  unrouted_rows bigint,
  station_summary jsonb,
  source_summary jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT public.has_permission('pos','menu','view') THEN
    RAISE EXCEPTION 'Not permitted to view menu import batches';
  END IF;

  RETURN QUERY
  WITH b AS (
    SELECT mb.*
      FROM public.menu_import_batches mb
     WHERE mb.organization_id = _org
       AND (_branch IS NULL OR mb.branch_id IS NULL OR mb.branch_id = _branch)
       AND public.neo_branch_in_scope(mb.branch_id)
  ),
  resolved AS (
    SELECT mi.import_batch_id AS bid,
           mi.active_to,
           mi.publish_status,
           coalesce(st.name, 'Unrouted') AS station,
           coalesce(r.res->>'source', 'none') AS source,
           coalesce((r.res->>'missing')::boolean, true) AS missing
      FROM public.menu_items mi
      CROSS JOIN LATERAL (
        SELECT public.neo_kitchen_resolve_station(_org, mi.branch_id, mi.id, mi.category_id, NULL, NULL) AS res
      ) r
      LEFT JOIN public.operational_stations st ON st.id = nullif(r.res->>'station_id','')::uuid
     WHERE mi.organization_id = _org
       AND mi.import_batch_id IS NOT NULL
  ),
  rows_per_batch AS (
    SELECT bid,
           count(*) AS item_rows,
           count(*) FILTER (WHERE active_to IS NULL) AS live_rows,
           count(*) FILTER (WHERE active_to IS NOT NULL) AS historical_rows,
           count(*) FILTER (WHERE publish_status = 'published') AS published_rows,
           count(*) FILTER (WHERE publish_status = 'draft') AS draft_rows,
           count(*) FILTER (WHERE missing) AS unrouted_rows
      FROM resolved GROUP BY bid
  ),
  station_agg AS (
    SELECT bid, jsonb_object_agg(station, n) AS summary
      FROM (SELECT bid, station, count(*) AS n FROM resolved GROUP BY bid, station) t
     GROUP BY bid
  ),
  source_agg AS (
    SELECT bid, jsonb_object_agg(source, n) AS summary
      FROM (SELECT bid, source, count(*) AS n FROM resolved GROUP BY bid, source) t
     GROUP BY bid
  )
  SELECT b.id,
         b.file_name,
         b.file_type,
         b.reference,
         b.status,
         b.branch_id,
         br.name,
         b.menu_id,
         m.name,
         b.total_rows,
         b.imported_rows,
         b.committed_rows,
         b.rejected_rows,
         b.duplicate_rows,
         b.created_at,
         p.full_name,
         b.status = 'superseded',
         later.id,
         earlier.id,
         coalesce(r.item_rows, 0),
         coalesce(r.live_rows, 0),
         coalesce(r.historical_rows, 0),
         coalesce(r.published_rows, 0),
         coalesce(r.draft_rows, 0),
         coalesce(r.unrouted_rows, 0),
         coalesce(sa.summary, '{}'::jsonb),
         coalesce(so.summary, '{}'::jsonb)
    FROM b
    LEFT JOIN public.branches br ON br.id = b.branch_id
    LEFT JOIN public.menus m ON m.id = b.menu_id
    LEFT JOIN public.profiles p ON p.id = b.created_by
    LEFT JOIN rows_per_batch r ON r.bid = b.id
    LEFT JOIN station_agg sa ON sa.bid = b.id
    LEFT JOIN source_agg so ON so.bid = b.id
    LEFT JOIN LATERAL (
      SELECT n.id FROM b AS n
       WHERE n.file_name = b.file_name AND n.created_at > b.created_at
       ORDER BY n.created_at LIMIT 1
    ) later ON b.status = 'superseded'
    LEFT JOIN LATERAL (
      SELECT o.id FROM b AS o
       WHERE o.file_name = b.file_name AND o.created_at < b.created_at
       ORDER BY o.created_at DESC LIMIT 1
    ) earlier ON true
   ORDER BY b.created_at DESC;
END $function$;

REVOKE EXECUTE ON FUNCTION public.neo_menu_import_batches(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_menu_import_batches(uuid) TO authenticated;
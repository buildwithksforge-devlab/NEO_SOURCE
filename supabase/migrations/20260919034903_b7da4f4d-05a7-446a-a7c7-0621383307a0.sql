-- 1. The item's own default store, validated against workspace and property.
CREATE OR REPLACE FUNCTION public.neo_stock_item_default_store(_org uuid, _item uuid, _branch uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sl.id
    FROM stock_items si
    JOIN stock_locations sl ON sl.id = si.default_location_id
   WHERE si.id = _item
     AND si.organization_id = _org
     AND sl.organization_id = _org
     AND sl.active
     AND (sl.branch_id IS NULL OR _branch IS NULL OR sl.branch_id = _branch)
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.neo_stock_item_default_store(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_item_default_store(uuid, uuid, uuid) TO service_role;

-- 2. Canonical precedence: explicit destination -> item default store -> item group fallback store.
--    Returns NULL when none applies, so callers must ask for a store rather than guess.
CREATE OR REPLACE FUNCTION public.neo_stock_resolve_location(
  _org uuid, _item uuid, _branch uuid, _explicit uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT sl.id FROM stock_locations sl
      WHERE sl.id = _explicit AND sl.organization_id = _org AND sl.active
        AND (sl.branch_id IS NULL OR _branch IS NULL OR sl.branch_id = _branch)),
    public.neo_stock_item_default_store(_org, _item, _branch),
    public.neo_item_group_store(_org, _item, _branch)
  );
$$;

REVOKE ALL ON FUNCTION public.neo_stock_resolve_location(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_resolve_location(uuid, uuid, uuid, uuid) TO service_role;

-- 3. Existing consumers of the group store now go through the precedence resolver,
--    so an item's own default store wins over its group's fallback.
DO $do$
DECLARE r record; v_def text; v_new text;
BEGIN
  FOR r IN
    SELECT p.oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('inventory_consume_order_item_core','neo_kitchen_waste_post',
                         'neo_minibar_post','neo_production_batch_post')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def,
      'public\.neo_item_group_store\(([^;]{0,120}?)\)',
      'public.neo_stock_resolve_location(\1, NULL)', 'g');
    IF v_new IS DISTINCT FROM v_def THEN
      EXECUTE v_new;
    END IF;
  END LOOP;
END
$do$;

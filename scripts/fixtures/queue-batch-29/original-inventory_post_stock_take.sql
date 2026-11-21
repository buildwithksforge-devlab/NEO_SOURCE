CREATE OR REPLACE FUNCTION public.inventory_post_stock_take(_take uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  s record;
  l record;
  v_value numeric := 0;
BEGIN
  IF NOT has_permission('inventory','stocktake.manage') THEN RAISE EXCEPTION 'Not permitted to close stock takes'; END IF;
  SELECT * INTO s FROM stock_takes WHERE id = _take AND organization_id = v_org;
  IF s IS NULL THEN RAISE EXCEPTION 'Stock take not found'; END IF;
  IF s.status = 'closed' THEN RETURN jsonb_build_object('status','already-closed'); END IF;

  FOR l IN SELECT * FROM stock_take_lines WHERE stock_take_id = _take AND counted_quantity IS NOT NULL LOOP
    UPDATE stock_take_lines SET variance = l.counted_quantity - l.system_quantity WHERE id = l.id;
    IF l.counted_quantity <> l.system_quantity THEN
      PERFORM inventory_apply_movement(l.stock_item_id, s.location_id, l.counted_quantity - l.system_quantity, l.unit,
        'stock-take', NULL, 'stock_take', _take, 'Stock count variance',
        'stocktake:' || _take::text || ':' || l.id::text, NULL, NULL);
      v_value := v_value + ((l.counted_quantity - l.system_quantity) * COALESCE(NULLIF(l.unit_cost, 0), 0));
    END IF;
  END LOOP;

  UPDATE stock_takes SET status = 'closed', completed_at = now(), variance_value = v_value, approved_by = auth.uid() WHERE id = _take;
  RETURN jsonb_build_object('status','closed','variance',v_value);
END;
$function$
;

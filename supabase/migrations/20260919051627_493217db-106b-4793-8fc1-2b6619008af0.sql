-- Link a reported need to a catalogue item, so Stores can issue against it.
CREATE OR REPLACE FUNCTION public.neo_stock_need_link_item(_need uuid, _stock_item uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  n public.department_stock_needs;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT public.neo_can_transfer_stock() THEN
    RAISE EXCEPTION 'Not permitted to work on stock needs';
  END IF;

  SELECT * INTO n FROM public.department_stock_needs
   WHERE id = _need AND organization_id = v_org FOR UPDATE;
  IF n.id IS NULL THEN RAISE EXCEPTION 'Stock need not found'; END IF;

  IF _stock_item IS NOT NULL THEN
    PERFORM 1 FROM public.stock_items
     WHERE id = _stock_item AND organization_id = v_org
       AND (branch_id IS NULL OR n.branch_id IS NULL OR branch_id = n.branch_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'That item is not part of this property''s catalogue'; END IF;
  END IF;

  UPDATE public.department_stock_needs
     SET stock_item_id = _stock_item,
         status = CASE WHEN status = 'reported' THEN 'acknowledged' ELSE status END,
         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   WHERE id = _need;

  RETURN jsonb_build_object('ok', true, 'need_id', _need, 'stock_item_id', _stock_item);
END $function$;

REVOKE ALL ON FUNCTION public.neo_stock_need_link_item(uuid,uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_stock_need_link_item(uuid,uuid) TO authenticated;

-- NEØ actual inventory consumption costing.
-- Use recorded movement valuation after base-unit conversion.
-- No historical transactions are modified.

BEGIN;

DO $patch$
DECLARE
    d text;
    old_anchor text;
    new_anchor text;
BEGIN
    d := pg_get_functiondef(
        'public.inventory_consume_order_item_core(uuid)'::regprocedure
    );

    IF md5(d) <> 'b5c6e74396dc4b5efd9443eed828c8c7' THEN
        RAISE EXCEPTION 'Inventory consumption source drift';
    END IF;

    old_anchor := $old$v_cost numeric := 0;$old$;

    new_anchor := $new$v_cost numeric := 0;
  v_actual_movement uuid;
  v_actual_value numeric;$new$;

    IF length(d) - length(replace(d,old_anchor,''))
       <> length(old_anchor) THEN
        RAISE EXCEPTION 'Consumption declaration anchor changed';
    END IF;

    d := replace(d,old_anchor,new_anchor);

    old_anchor := $old$PERFORM public.inventory_apply_movement(
      v_comp.item_id,$old$;

    new_anchor := $new$v_actual_movement := public.inventory_apply_movement(
      v_comp.item_id,$new$;

    IF length(d) - length(replace(d,old_anchor,''))
       <> length(old_anchor) THEN
        RAISE EXCEPTION 'Consumption movement anchor changed';
    END IF;

    d := replace(d,old_anchor,new_anchor);

    old_anchor := $old$v_cost :=
      v_cost
      + v_comp.qty * COALESCE(v_stock.average_cost, 0);$old$;

    new_anchor := $new$SELECT abs(m.value)
      INTO STRICT v_actual_value
      FROM public.stock_movements m
     WHERE m.id = v_actual_movement
       AND m.organization_id = v_org
       AND m.stock_item_id = v_comp.item_id
       AND m.location_id = v_line_location
       AND m.reference_type = 'pos_order_item'
       AND m.reference_id = _order_item
       AND m.movement_type = v_movement_type
       AND m.idempotency_key = v_key
       AND m.quantity < 0;

    IF v_actual_value IS NULL
       OR v_actual_value::text IN ('NaN','Infinity','-Infinity')
    THEN
      RAISE EXCEPTION 'Invalid recorded inventory consumption value'
        USING ERRCODE = '23514';
    END IF;

    v_cost := v_cost + v_actual_value;$new$;

    IF length(d) - length(replace(d,old_anchor,''))
       <> length(old_anchor) THEN
        RAISE EXCEPTION 'Consumption valuation anchor changed';
    END IF;

    d := replace(d,old_anchor,new_anchor);

    EXECUTE d;
END;
$patch$;

COMMIT;